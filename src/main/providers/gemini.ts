import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { APICallError, generateText } from 'ai'
import type { ModelInfo } from '../../shared/ipc'
import { describeHttpStatus } from './errors'
import { ProviderError, type AdapterFactory, type FetchFn } from './types'

// Endpoint and resource shape from Google's API reference (models.list), checked 2026-11-12:
// GET {base}/models?pageSize=&pageToken=, with the key in the x-goog-api-key header.
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const PAGE_SIZE = 1000
const MAX_PAGES = 20
const REQUEST_TIMEOUT_MS = 30_000

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

async function providerMessageOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } }
    return typeof body.error?.message === 'string' ? body.error.message : undefined
  } catch {
    return undefined
  }
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
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
        if (!response.ok) {
          throw new ProviderError(describeHttpStatus(response.status, await providerMessageOf(response)))
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

    async generateText({ modelId, prompt }) {
      try {
        const result = await generateText({
          model: google(modelId),
          prompt,
          // One attempt only: retries would multiply calls against low free-tier rate limits.
          maxRetries: 0,
          timeout: REQUEST_TIMEOUT_MS
        })
        return result.text
      } catch (error) {
        if (APICallError.isInstance(error) && error.statusCode !== undefined) {
          throw new ProviderError(describeHttpStatus(error.statusCode, error.message))
        }
        throw error
      }
    }
  }
}
