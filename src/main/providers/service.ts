import { createHash } from 'node:crypto'
import type { ModelInfo, ProviderSettingsState, TestResult } from '../../shared/ipc'
import type { UsageSummary } from '../../shared/knowledge'
import { toUserMessage } from './errors'
import { KeyStore, type Encryptor, type KeyValueStore } from './keystore'
import { costUsd, priceOf, setUserPrice } from './pricing'
import { PauseError, RateLimiter, realClock, withRetries, type Clock } from './rateLimiter'
import type { AdapterFactory, FetchFn, GenerateRequest, ProviderAdapter, ThinkingLevel, TokenUsage } from './types'
import type { CallOutcome, UsageStore, UsageTotals } from './usage'

const SETTINGS_KEY_API_KEY = 'provider.gemini.apiKeyEncrypted'
const SETTINGS_KEY_MODEL = 'provider.gemini.model'
const SETTINGS_KEY_RPM = 'provider.gemini.requestsPerMinute'

/**
 * Google does not publish free-tier limits for the flash-lite models (rate-limits page, checked
 * 2026-11-13); its limit errors are honoured whatever this is set to. Ten a minute stays under
 * the free-tier limits Google has published for other models.
 */
export const DEFAULT_REQUESTS_PER_MINUTE = 10
const MAX_REQUESTS_PER_MINUTE = 1000

/**
 * Preferred default models, in order. Used only to pre-fill the choice; the user can pick any
 * model the key can reach.
 *
 * Checked 2026-11-12: gemini-2.5-flash-lite is cheaper but still appears in models.list while
 * rejecting new users ("no longer available to new users ... use gemini-3.5-flash-lite"), so it
 * is not offered as a default. gemini-3.1-flash-lite is cheaper than 3.5 on the paid tier but
 * has not been verified with a new key.
 */
export const PREFERRED_DEFAULT_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] as const

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_KEY_LENGTH = 512

/**
 * The jobs a model does. Each role gets its own model in milestone 6; until then every role uses
 * the one selected model.
 */
export type Role = 'teaching' | 'grading' | 'ingestion' | 'research'

/** Replies that fail validation are tried this many times in all before the task fails. */
export const MAX_VALIDATION_ATTEMPTS = 3

/** Thrown by a task's `parse` when a reply does not fit, and by `run` when no attempt fitted. Nothing is stored. */
export class InvalidOutputError extends Error {
  override readonly name = 'InvalidOutputError'
}

/** One model request on behalf of a session, cached by content and counted against the session's caps. */
export interface ModelTask<T> {
  role: Role
  sessionId: number
  jobId: number | null
  /** The prompt's name and a hash of its text: changing the prompt changes the cache key. */
  prompt: { name: string; version: number; hash: string }
  system?: string
  text: string
  images?: Uint8Array[]
  jsonSchema?: Record<string, unknown>
  thinking: ThinkingLevel
  maxOutputTokens: number
  /** Identifies everything else the reply depends on (the content sent, including images). */
  contentKey: string
  /** Expected tokens, recorded next to the actual ones so later estimates can be calibrated. */
  estimate: { inputTokens: number; outputTokens: number }
  /** Turns the reply text into a value, throwing InvalidOutputError if it does not fit. */
  parse: (text: string) => T
  signal?: AbortSignal
}

export interface ModelTaskResult<T> {
  value: T
  cached: boolean
}

export interface ProviderServiceOptions {
  settings: KeyValueStore
  encryptor: Encryptor
  createAdapter: AdapterFactory
  /** Key from .env.local; only passed in unpackaged development builds. */
  devKey: string | null
  /** Loads a prompt file from prompts/ by name. */
  loadPrompt: (name: string) => string
  /** The model cache and request ledger. */
  usage: UsageStore
  /** A session's caps; null means no cap. */
  limits: (sessionId: number) => { callCap: number | null; spendCapUsd: number | null }
  fetch?: FetchFn
  clock?: Clock
}

/** Thrown for problems the user caused or can fix; the message is shown as-is. */
export class UserFacingError extends Error {
  override readonly name = 'UserFacingError'
}

export function cacheKeyOf(prompt: { name: string; hash: string }, model: string, contentKey: string): string {
  return createHash('sha256').update(JSON.stringify([prompt.name, prompt.hash, model, contentKey])).digest('hex')
}

/** The providers module's public service. The only place that holds a decrypted key. */
export class ProviderService {
  private readonly keys: KeyStore
  private cachedModels: ModelInfo[] | null = null
  private readonly limiter: RateLimiter
  private readonly clock: Clock

  constructor(private readonly options: ProviderServiceOptions) {
    this.keys = new KeyStore(SETTINGS_KEY_API_KEY, options.settings, options.encryptor, options.devKey)
    this.clock = options.clock ?? realClock
    this.limiter = new RateLimiter(() => this.requestsPerMinute(), this.clock)
  }

  getState(): ProviderSettingsState {
    return {
      provider: 'gemini',
      keySource: this.keys.active().source,
      canStoreKey: this.keys.canStore(),
      selectedModel: this.options.settings.get(SETTINGS_KEY_MODEL)
    }
  }

  saveKey(apiKey: string): ProviderSettingsState {
    const trimmed = apiKey.trim()
    if (trimmed.length === 0) throw new UserFacingError('Enter an API key.')
    if (trimmed.length > MAX_KEY_LENGTH || /\s/.test(trimmed)) {
      throw new UserFacingError('That does not look like an API key. Paste it again without spaces.')
    }
    this.keys.save(trimmed)
    this.cachedModels = null
    return this.getState()
  }

  clearKey(): ProviderSettingsState {
    this.keys.clear()
    this.cachedModels = null
    return this.getState()
  }

  selectModel(modelId: string): ProviderSettingsState {
    if (!MODEL_ID_PATTERN.test(modelId)) throw new UserFacingError('Invalid model id.')
    if (this.cachedModels && !this.cachedModels.some((m) => m.id === modelId)) {
      throw new UserFacingError(`Model ${modelId} is not available for this key.`)
    }
    this.options.settings.set(SETTINGS_KEY_MODEL, modelId)
    return this.getState()
  }

  /** Lists models live from the provider. Pre-selects the cheapest preferred model if none is chosen. */
  async listModels(): Promise<ModelInfo[]> {
    const models = await this.adapter().listModels()
    this.cachedModels = models
    if (this.options.settings.get(SETTINGS_KEY_MODEL) === null) {
      const preferred = PREFERRED_DEFAULT_MODELS.find((id) => models.some((m) => m.id === id))
      const fallback = preferred ?? models[0]?.id
      if (fallback) this.options.settings.set(SETTINGS_KEY_MODEL, fallback)
    }
    return models
  }

  /** Sends the connection-test prompt to the selected model. Exactly one model call. */
  async test(): Promise<TestResult> {
    const model = this.options.settings.get(SETTINGS_KEY_MODEL)
    if (!model) throw new UserFacingError('Choose a model first.')
    const prompt = this.options.loadPrompt('connection-test')
    const started = Date.now()
    const reply = await this.adapter().generate({ modelId: model, prompt })
    this.options.usage.record({ sessionId: null, jobId: null, prompt: 'connection-test', model, cacheKey: null, outcome: 'ok', usage: reply.usage, estimate: null })
    return { model, reply: reply.text.trim(), elapsedMs: Date.now() - started }
  }

  /** The model assigned to a role. Every role uses the selected model until milestone 6. */
  modelForRole(role: Role): string {
    void role
    const model = this.options.settings.get(SETTINGS_KEY_MODEL)
    if (!model) throw new UserFacingError('Choose a model in Settings first.')
    return model
  }

  /** The provider's name, for notices about what is sent where. */
  providerName(): string {
    return 'Google Gemini'
  }

  requestsPerMinute(): number {
    const saved = Number(this.options.settings.get(SETTINGS_KEY_RPM))
    return Number.isInteger(saved) && saved >= 1 ? saved : DEFAULT_REQUESTS_PER_MINUTE
  }

  setRequestsPerMinute(rpm: number): void {
    if (!Number.isInteger(rpm) || rpm < 1 || rpm > MAX_REQUESTS_PER_MINUTE) {
      throw new UserFacingError(`Requests per minute must be a whole number from 1 to ${MAX_REQUESTS_PER_MINUTE}.`)
    }
    this.options.settings.set(SETTINGS_KEY_RPM, String(rpm))
  }

  /** Saves the user's price for a model in dollars per million tokens, or clears it with null. */
  setPrice(modelId: string, price: { input: number; output: number } | null): void {
    if (!MODEL_ID_PATTERN.test(modelId)) throw new UserFacingError('Invalid model id.')
    if (price && ![price.input, price.output].every((v) => Number.isFinite(v) && v >= 0 && v < 1000)) {
      throw new UserFacingError('Enter prices in dollars per million tokens.')
    }
    setUserPrice(modelId, price, this.options.settings)
  }

  /** What a number of tokens on a model would cost, or null when the model's price is unknown. */
  costOf(model: string, tokens: { inputTokens: number; outputTokens: number }): number | null {
    const price = priceOf(model, this.options.settings)
    return price ? costUsd(price, tokens) : null
  }

  /** Cost of recorded usage, or null if any model in it has no known price. */
  costOfTotals(totals: UsageTotals): number | null {
    let sum = 0
    for (const m of totals.byModel) {
      const cost = this.costOf(m.model, m)
      if (cost === null) return null
      sum += cost
    }
    return sum
  }

  jobTotals(jobId: number): UsageTotals {
    return this.options.usage.jobTotals(jobId)
  }

  /** Recent actual-to-estimated token ratios for a prompt on the current model. */
  calibration(role: Role, prompt: string): { inputFactor: number; outputFactor: number; samples: number } {
    return this.options.usage.calibration(prompt, this.modelForRole(role))
  }

  usageSummary(sessionId: number): UsageSummary {
    const totals = this.options.usage.sessionTotals(sessionId)
    const limits = this.options.limits(sessionId)
    const model = this.options.settings.get(SETTINGS_KEY_MODEL)
    const price = model ? priceOf(model, this.options.settings) : null
    return {
      sessionId,
      calls: totals.calls,
      requests: totals.requests,
      cacheHits: totals.cacheHits,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costUsd: this.costOfTotals(totals),
      callCap: limits.callCap,
      spendCapUsd: limits.spendCapUsd,
      model,
      price,
      requestsPerMinute: this.requestsPerMinute()
    }
  }

  /** Whether a task's reply is already cached for the current model, so estimates count only new calls. */
  isCached(role: Role, prompt: { name: string; hash: string }, contentKey: string): boolean {
    return this.options.usage.cacheGet(cacheKeyOf(prompt, this.modelForRole(role), contentKey)) !== undefined
  }

  /**
   * Runs one model task. A reply cached for the same prompt, model and content is reused without
   * a request. Otherwise the session's caps are checked, the request goes through the rate
   * limiter, and a reply that fails `parse` is tried again, up to MAX_VALIDATION_ATTEMPTS times in
   * all. Only a valid reply is cached. Every request is recorded in the ledger.
   * Throws PauseError (caps, quota, repeated limit errors) or InvalidOutputError.
   */
  async run<T>(task: ModelTask<T>): Promise<ModelTaskResult<T>> {
    const model = this.modelForRole(task.role)
    const key = cacheKeyOf(task.prompt, model, task.contentKey)
    const record = (outcome: CallOutcome, usage: TokenUsage | null): void =>
      this.options.usage.record({
        sessionId: task.sessionId,
        jobId: task.jobId,
        prompt: task.prompt.name,
        model,
        cacheKey: key,
        outcome,
        usage,
        estimate: outcome === 'ok' || outcome === 'invalid' ? task.estimate : null
      })

    const cached = this.options.usage.cacheGet(key)
    if (cached !== undefined) {
      try {
        const value = task.parse(cached)
        record('cache-hit', null)
        return { value, cached: true }
      } catch (error) {
        // Validation has become stricter since this reply was stored; ask again.
        if (!(error instanceof InvalidOutputError)) throw error
      }
    }

    const request: GenerateRequest = {
      modelId: model,
      prompt: task.text,
      thinking: task.thinking,
      maxOutputTokens: task.maxOutputTokens,
      ...(task.system ? { system: task.system } : {}),
      ...(task.images ? { images: task.images } : {}),
      ...(task.jsonSchema ? { jsonSchema: task.jsonSchema } : {})
    }
    let lastProblem = ''
    for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
      this.checkCaps(task.sessionId, model, task.estimate)
      const adapter = this.adapter()
      const reply = await withRetries(this.limiter, () => adapter.generate(request), {
        clock: this.clock,
        ...(task.signal ? { signal: task.signal } : {}),
        onFailedAttempt: ({ kind }) => record(kind === 'rate-limit' ? 'rate-limited' : kind === 'quota-daily' ? 'quota' : 'error', null)
      })
      try {
        const value = task.parse(reply.text)
        record('ok', reply.usage)
        this.options.usage.cachePut({ key, prompt: task.prompt.name, promptVersion: task.prompt.version, model, response: reply.text, usage: reply.usage })
        return { value, cached: false }
      } catch (error) {
        if (!(error instanceof InvalidOutputError)) throw error
        record('invalid', reply.usage)
        lastProblem = error.message
      }
    }
    throw new InvalidOutputError(`The model's reply did not have the expected form after ${MAX_VALIDATION_ATTEMPTS} tries (${lastProblem}).`)
  }

  /** Converts any error into a message safe to send to the renderer (the key is always redacted). */
  safeErrorMessage(error: unknown): string {
    let key: string | null = null
    try {
      key = this.keys.active().key
    } catch {
      // If the key cannot be read, there is nothing to redact from it.
    }
    return toUserMessage(error, key ? [key] : [])
  }

  private checkCaps(sessionId: number, model: string, estimate: { inputTokens: number; outputTokens: number }): void {
    const limits = this.options.limits(sessionId)
    const totals = this.options.usage.sessionTotals(sessionId)
    if (limits.callCap !== null && totals.calls + 1 > limits.callCap) {
      throw new PauseError(`This session has used its cap of ${limits.callCap} model calls. Raise the cap to continue.`, 'cap', null)
    }
    if (limits.spendCapUsd !== null) {
      const spent = this.costOfTotals(totals)
      const next = this.costOf(model, estimate)
      if (spent !== null && next !== null && spent + next > limits.spendCapUsd) {
        throw new PauseError(`The next call would pass this session's spending cap of $${limits.spendCapUsd.toFixed(2)}. Raise the cap to continue.`, 'cap', null)
      }
    }
  }

  private adapter(): ProviderAdapter {
    const { key } = this.keys.active()
    if (!key) throw new UserFacingError('Add a Gemini API key first.')
    return this.options.createAdapter(this.options.fetch ? { apiKey: key, fetch: this.options.fetch } : { apiKey: key })
  }
}
