// Providers module: adapters, model listing and key storage.
// This is the only module allowed to import a provider SDK.
export { createGeminiAdapter, GEMINI_BASE_URL } from './gemini'
export { ProviderService, UserFacingError, PREFERRED_DEFAULT_MODELS, type ProviderServiceOptions } from './service'
export type { Encryptor, KeyValueStore } from './keystore'
export { ProviderError, type AdapterFactory, type AdapterOptions, type ProviderAdapter } from './types'
export { redact, toUserMessage } from './errors'
