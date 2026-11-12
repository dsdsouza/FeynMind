// The contract between the main process and the renderer.
// Every channel is listed here with its request and response types.
// The renderer only ever sees these types; it never sees an API key.

export type ProviderId = 'gemini'

export interface ModelInfo {
  /** The id passed to generation calls, e.g. "gemini-2.5-flash-lite". */
  id: string
  displayName: string
  description: string
  inputTokenLimit: number | null
  outputTokenLimit: number | null
}

/** Where the active key came from. The key itself never crosses IPC. */
export type KeySource = 'stored' | 'env' | 'none'

export interface ProviderSettingsState {
  provider: ProviderId
  keySource: KeySource
  /** False when the operating system cannot encrypt secrets (e.g. Linux without a keyring). */
  canStoreKey: boolean
  selectedModel: string | null
}

export interface TestResult {
  model: string
  reply: string
  elapsedMs: number
}

/** Every IPC response is either a value or a user-safe error message. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface IpcContract {
  'settings:getState': { request: undefined; response: ProviderSettingsState }
  'settings:saveKey': { request: { apiKey: string }; response: ProviderSettingsState }
  'settings:clearKey': { request: undefined; response: ProviderSettingsState }
  'settings:selectModel': { request: { modelId: string }; response: ProviderSettingsState }
  'provider:listModels': { request: undefined; response: ModelInfo[] }
  'provider:test': { request: undefined; response: TestResult }
}

export type IpcChannel = keyof IpcContract
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request']
export type IpcResponse<C extends IpcChannel> = Result<IpcContract[C]['response']>

export const IPC_CHANNELS = [
  'settings:getState',
  'settings:saveKey',
  'settings:clearKey',
  'settings:selectModel',
  'provider:listModels',
  'provider:test'
] as const satisfies readonly IpcChannel[]

/** The API the preload script exposes on window.feynmind. */
export type FeynMindApi = {
  [C in IpcChannel]: IpcRequest<C> extends undefined
    ? () => Promise<IpcResponse<C>>
    : (request: IpcRequest<C>) => Promise<IpcResponse<C>>
}
