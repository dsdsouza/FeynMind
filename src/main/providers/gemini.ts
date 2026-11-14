import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { APICallError, generateText, jsonSchema, NoObjectGeneratedError, Output, streamText, type LanguageModelUsage } from 'ai'
import type { ModelInfo } from '../../shared/ipc'
import { describeHttpStatus } from './errors'
import { ProviderError, type AdapterFactory, type FetchFn, type GenerateRequest, type GenerateResult, type TokenUsage } from './types'

// Endpoint and resource shape from Google's API reference (models.list), checked 2026-11-12:
// GET {base}/models?pageSize=&pageToken=, with the key in the x-goog-api-key header.
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const PAGE_SIZE = 1000
const MAX_PAGES = 20
const LIST_TIMEOUT_MS = 30_000
/** Long enough for a page image or a whole section; the rate limiter retries a timeout. */
const GENERATE_TIMEOUT_MS = 180_000

interface RawModel {
  name?: unknown
  displayName?: unknown
  description?: unknown
  inputTokenLimit?: unknown
  outputTokenLimit?: unknown
  supportedGenerationMethods?: unknown
}

interface RawListResponse {
  models?: RawModel[]
  nextPageToken?: string
}

function toModelInfo(raw: RawModel): ModelInfo | null {
  if (typeof raw.name !== 'string' || !raw.name.startsWith('models/')) return null
  const methods = Array.isArray(raw.supportedGenerationMethods) ? raw.supportedGenerationMethods : []
  if (!methods.includes('generateContent')) return null
  const id = raw.name.slice('models/'.length)
  return {
    id,
    displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : id,
    description: typeof raw.description === 'string' ? raw.description : '',
    inputTokenLimit: typeof raw.inputTokenLimit === 'number' ? raw.inputTokenLimit : null,
    outputTokenLimit: typeof raw.outputTokenLimit === 'number' ? raw.outputTokenLimit : null
  }
}

interface GoogleErrorBody {
  error?: { code?: unknown; message?: unknown; status?: unknown; details?: unknown }
}

function parseBody(text: string | undefined): GoogleErrorBody | null {
  if (!text) return null
  try {
    return JSON.parse(text) as GoogleErrorBody
  } catch {
    return null
  }
}

/** "34s" or "1.5s" (protobuf Duration as JSON) to milliseconds. */
function durationMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim())
  return match ? Math.ceil(Number(match[1]) * 1000) : null
}

/**
 * Classifies an error response from the Gemini API.
 *
 * Google documents 429 RESOURCE_EXHAUSTED and 503 UNAVAILABLE as transient and to be retried with
 * backoff (troubleshooting page, checked 2026-11-13), and that daily quotas reset at midnight
 * Pacific time (rate-limits page). It does not publish a full 429 body. Observed bodies carry a
 * `details` array with a google.rpc.RetryInfo (`retryDelay`, e.g. "21s") and a
 * google.rpc.QuotaFailure whose violations name the quota (`quotaId`, e.g.
 * "GenerateRequestsPerDayPerProjectPerModel-FreeTier"). A per-day quota is treated as exhausted
 * until the reset; anything else as a short-term limit. Many 429s carry no details at all, so
 * those are a short-term limit with no known delay.
 */
export function classifyGeminiError(status: number, bodyText: string | undefined): ProviderError {
  const body = parseBody(bodyText)
  const providerMessage = typeof body?.error?.message === 'string' ? body.error.message : undefined
  const message = describeHttpStatus(status, providerMessage ? shorten(providerMessage) : undefined)
  if (status === 429) {
    const details = Array.isArray(body?.error?.details) ? (body.error.details as Record<string, unknown>[]) : []
    let retryAfterMs: number | null = null
    let daily = false
    for (const detail of details) {
      const type = typeof detail['@type'] === 'string' ? detail['@type'] : ''
      if (type.endsWith('google.rpc.RetryInfo')) retryAfterMs = durationMs(detail['retryDelay'])
      if (type.endsWith('google.rpc.QuotaFailure') && Array.isArray(detail['violations'])) {
        for (const violation of detail['violations'] as Record<string, unknown>[]) {
          const id = `${String(violation['quotaId'] ?? '')} ${String(violation['quotaMetric'] ?? '')}`
          if (/PerDay|Daily/i.test(id)) daily = true
        }
      }
    }
    return daily
      ? new ProviderError('The daily request quota for this model is used up. It resets at midnight Pacific time.', 'quota-daily')
      : new ProviderError(message, 'rate-limit', retryAfterMs)
  }
  if (status === 401 || status === 403) return new ProviderError(message, 'auth')
  if (status === 404) return new ProviderError(message, 'not-found')
  if (status === 408) return new ProviderError(message, 'timeout')
  if (status >= 500) return new ProviderError(message, 'overloaded')
  return new ProviderError(message, 'bad-request')
}

function shorten(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

async function providerMessageOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } }
    return typeof body.error?.message === 'string' ? body.error.message : undefined
  } catch {
    return undefined
  }
}

/**
 * Billed tokens. Google bills thinking as output; its raw usage reports the reply
 * (candidatesTokenCount) and thinking (thoughtsTokenCount) separately, so they are added here
 * rather than relying on how the SDK combines them.
 */
export function usageOf(usage: LanguageModelUsage | undefined): TokenUsage {
  const raw = (usage?.raw ?? {}) as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const prompt = num(raw['promptTokenCount'])
  const candidates = num(raw['candidatesTokenCount'])
  const thoughts = num(raw['thoughtsTokenCount']) ?? 0
  if (prompt !== null && candidates !== null) {
    return { inputTokens: prompt, outputTokens: candidates + thoughts, thinkingTokens: thoughts }
  }
  const thinking = usage?.outputTokenDetails.reasoningTokens ?? 0
  return { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, thinkingTokens: thinking }
}

/** Options shared by generate and stream: the model, the messages, thinking and media settings, one attempt. */
function callOptions(google: ReturnType<typeof createGoogleGenerativeAI>, request: GenerateRequest) {
  const images = request.images ?? []
  const content = [
    { type: 'text' as const, text: request.prompt },
    ...images.map((data) => ({ type: 'file' as const, mediaType: 'image/png', data }))
  ]
  return {
    model: google(request.modelId),
    ...(request.system ? { system: request.system } : {}),
    messages: [{ role: 'user' as const, content }],
    ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
    providerOptions: {
      google: {
        ...(request.thinking ? { thinkingConfig: { thinkingLevel: request.thinking } } : {}),
        // 1120 tokens per image on Gemini 3 (media-resolution page, checked 2026-11-13): small
        // subscripts and matrix entries need the high setting, and a fixed count keeps estimates exact.
        ...(images.length > 0 ? { mediaResolution: 'MEDIA_RESOLUTION_HIGH' } : {})
      }
    },
    // One attempt only: the rate limiter decides when to try again.
    maxRetries: 0,
    timeout: GENERATE_TIMEOUT_MS
  }
}

/** Turns an SDK or network error into a ProviderError the rate limiter understands. */
function toProviderError(error: unknown): unknown {
  if (error instanceof ProviderError) return error
  if (APICallError.isInstance(error) && error.statusCode !== undefined) return classifyGeminiError(error.statusCode, error.responseBody)
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new ProviderError('The provider did not answer in time.', 'timeout')
  }
  if (APICallError.isInstance(error)) return new ProviderError('Could not reach the provider. Check the connection.', 'network')
  return error
}

export const createGeminiAdapter: AdapterFactory = ({ apiKey, fetch }) => {
  const doFetch: FetchFn = fetch ?? globalThis.fetch
  // apiKey is always passed explicitly, so the SDK never falls back to its own env variable.
  const google = createGoogleGenerativeAI({ apiKey, baseURL: GEMINI_BASE_URL, fetch: doFetch })

  return {
    id: 'gemini',

    async listModels() {
      const models: ModelInfo[] = []
      let pageToken: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(`${GEMINI_BASE_URL}/models`)
        url.searchParams.set('pageSize', String(PAGE_SIZE))
        if (pageToken) url.searchParams.set('pageToken', pageToken)

        const response = await doFetch(url, {
          headers: { 'x-goog-api-key': apiKey },
          signal: AbortSignal.timeout(LIST_TIMEOUT_MS)
        })
        if (!response.ok) {
          throw new ProviderError(describeHttpStatus(response.status, await providerMessageOf(response)), response.status === 429 ? 'rate-limit' : 'bad-request')
        }
        const body = (await response.json()) as RawListResponse
        for (const raw of body.models ?? []) {
          const info = toModelInfo(raw)
          if (info) models.push(info)
        }
        pageToken = body.nextPageToken || undefined
        if (!pageToken) break
      }
      return models.sort((a, b) => a.id.localeCompare(b.id))
    },

    async generate(request: GenerateRequest): Promise<GenerateResult> {
      try {
        const result = await generateText({
          ...callOptions(google, request),
          ...(request.jsonSchema ? { output: Output.object({ schema: jsonSchema(request.jsonSchema) }) } : {})
        })
        return { text: result.text, usage: usageOf(result.usage) }
      } catch (error) {
        // The reply arrived (and was billed) but was not valid JSON for the schema: return it, the caller validates.
        if (NoObjectGeneratedError.isInstance(error)) return { text: error.text ?? '', usage: usageOf(error.usage) }
        throw toProviderError(error)
      }
    },

    async stream(request: GenerateRequest, onText: (text: string) => void): Promise<GenerateResult> {
      // streamText reports failures as parts of the stream rather than throwing, so each part is read here.
      // One attempt only: no retries before or after streaming starts (streamRetries omitted = off).
      let text = ''
      try {
        const result = streamText(callOptions(google, request))
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            text += part.text
            onText(part.text)
          } else if (part.type === 'error') {
            throw part.error
          } else if (part.type === 'abort') {
            throw new ProviderError('The provider did not answer in time.', 'timeout')
          } else if (part.type === 'finish') {
            return { text, usage: usageOf(part.totalUsage) }
          }
        }
      } catch (error) {
        throw toProviderError(error)
      }
      throw new ProviderError('The reply ended before it was complete.', 'network')
    }
  }
}
