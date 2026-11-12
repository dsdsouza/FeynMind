import type { ModelInfo, ProviderSettingsState, TestResult } from '../../shared/ipc'
import { toUserMessage } from './errors'
import { KeyStore, type Encryptor, type KeyValueStore } from './keystore'
import type { AdapterFactory, FetchFn, ProviderAdapter } from './types'

const SETTINGS_KEY_API_KEY = 'provider.gemini.apiKeyEncrypted'
const SETTINGS_KEY_MODEL = 'provider.gemini.model'

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

export interface ProviderServiceOptions {
  settings: KeyValueStore
  encryptor: Encryptor
  createAdapter: AdapterFactory
  /** Key from .env.local; only passed in unpackaged development builds. */
  devKey: string | null
  /** Loads a prompt file from prompts/ by name. */
  loadPrompt: (name: string) => string
  fetch?: FetchFn
}

/** Thrown for problems the user caused or can fix; the message is shown as-is. */
export class UserFacingError extends Error {
  override readonly name = 'UserFacingError'
}

/** The providers module's public service. The only place that holds a decrypted key. */
export class ProviderService {
  private readonly keys: KeyStore
  private cachedModels: ModelInfo[] | null = null

  constructor(private readonly options: ProviderServiceOptions) {
    this.keys = new KeyStore(SETTINGS_KEY_API_KEY, options.settings, options.encryptor, options.devKey)
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
    const reply = await this.adapter().generateText({ modelId: model, prompt })
    return { model, reply: reply.trim(), elapsedMs: Date.now() - started }
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

  private adapter(): ProviderAdapter {
    const { key } = this.keys.active()
    if (!key) throw new UserFacingError('Add a Gemini API key first.')
    return this.options.createAdapter(
      this.options.fetch ? { apiKey: key, fetch: this.options.fetch } : { apiKey: key }
    )
  }
}
