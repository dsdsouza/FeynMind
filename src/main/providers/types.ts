import type { ModelInfo, ProviderId } from '../../shared/ipc'

export type FetchFn = typeof globalThis.fetch

/** How much the model may think before answering. Thinking tokens are billed as output. */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'

export interface GenerateRequest {
  modelId: string
  /** Standing instructions, sent separately from the user content when the provider supports it. */
  system?: string
  prompt: string
  /** PNG images sent with the prompt, in order. */
  images?: Uint8Array[]
  /** A JSON schema the reply must follow; the reply text is then JSON. The caller still validates it. */
  jsonSchema?: Record<string, unknown>
  thinking?: ThinkingLevel
  maxOutputTokens?: number
}

/** Tokens a request was billed for. `outputTokens` includes `thinkingTokens`. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
}

export interface GenerateResult {
  text: string
  usage: TokenUsage
}

/** The fixed internal interface every provider adapter implements. */
export interface ProviderAdapter {
  readonly id: ProviderId
  /** Models this key can reach that can generate text. */
  listModels(): Promise<ModelInfo[]>
  /**
   * Sends one request and returns the reply text with its token usage. Makes exactly one attempt:
   * retrying and pacing are the rate limiter's job.
   */
  generate(request: GenerateRequest): Promise<GenerateResult>
  /**
   * Like `generate`, but passes the reply's text to `onText` piece by piece as it arrives, then
   * returns the whole reply. Plain text only (no JSON schema). Makes exactly one attempt; if it
   * fails part way, the pieces already passed on are not part of any result.
   */
  stream(request: GenerateRequest, onText: (text: string) => void): Promise<GenerateResult>
}

export interface AdapterOptions {
  apiKey: string
  /** Injected in tests so no real network call is made. */
  fetch?: FetchFn
}

export type AdapterFactory = (options: AdapterOptions) => ProviderAdapter

/**
 * What went wrong with a request, as far as retrying is concerned.
 * - `rate-limit`: too many requests for now; retry after `retryAfterMs` (or back off).
 * - `quota-daily`: the daily quota is used up; nothing succeeds until it resets.
 * - `overloaded`: the provider is busy or had a server error; back off and retry.
 * - `timeout` / `network`: the request may not have arrived; retry.
 * - `auth`, `not-found`, `bad-request`: retrying will not help.
 */
export type ProviderErrorKind = 'rate-limit' | 'quota-daily' | 'overloaded' | 'timeout' | 'network' | 'auth' | 'not-found' | 'bad-request'

/** An error whose message is already safe to show the user (no secrets, no raw payloads). */
export class ProviderError extends Error {
  override readonly name = 'ProviderError'
  constructor(
    message: string,
    readonly kind: ProviderErrorKind = 'bad-request',
    /** For `rate-limit`: how long the provider asked us to wait. */
    readonly retryAfterMs: number | null = null
  ) {
    super(message)
  }
}
