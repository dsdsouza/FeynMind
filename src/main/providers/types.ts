import type { ModelInfo, ProviderId } from '../../shared/ipc'

export type FetchFn = typeof globalThis.fetch

/** The fixed internal interface every provider adapter implements. */
export interface ProviderAdapter {
  readonly id: ProviderId
  /** Models this key can reach that can generate text. */
  listModels(): Promise<ModelInfo[]>
  /** Sends a single text prompt and returns the reply text. */
  generateText(request: { modelId: string; prompt: string }): Promise<string>
}

export interface AdapterOptions {
  apiKey: string
  /** Injected in tests so no real network call is made. */
  fetch?: FetchFn
}

export type AdapterFactory = (options: AdapterOptions) => ProviderAdapter

/** An error whose message is already safe to show the user (no secrets, no raw payloads). */
export class ProviderError extends Error {
  override readonly name = 'ProviderError'
}
