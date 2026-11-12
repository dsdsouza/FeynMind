import type { ModelInfo } from '../../../src/shared/ipc'
import type { AdapterFactory, AdapterOptions, Encryptor, ProviderAdapter } from '../../../src/main/providers'

export function model(id: string): ModelInfo {
  return { id, displayName: id, description: '', inputTokenLimit: null, outputTokenLimit: null }
}

/** A provider that never touches the network. Records every call so tests can assert on them. */
export class FakeProvider {
  models: ModelInfo[] = [model('fake-pro'), model('gemini-2.5-flash-lite')]
  reply = 'Hello from the fake model.'
  failWith: Error | null = null
  readonly calls: { method: 'listModels' | 'generateText'; apiKey: string; modelId?: string; prompt?: string }[] = []

  readonly factory: AdapterFactory = (options: AdapterOptions): ProviderAdapter => ({
    id: 'gemini',
    listModels: async () => {
      this.calls.push({ method: 'listModels', apiKey: options.apiKey })
      if (this.failWith) throw this.failWith
      return this.models
    },
    generateText: async ({ modelId, prompt }) => {
      this.calls.push({ method: 'generateText', apiKey: options.apiKey, modelId, prompt })
      if (this.failWith) throw this.failWith
      return this.reply
    }
  })
}

/** Reversible stand-in for safeStorage. Ciphertext never contains the plain text. */
export class FakeEncryptor implements Encryptor {
  constructor(public available = true) {}
  isEncryptionAvailable(): boolean {
    return this.available
  }
  encryptString(plainText: string): Buffer {
    return Buffer.from(`enc:${[...plainText].reverse().join('')}`, 'utf8')
  }
  decryptString(encrypted: Buffer): string {
    return [...encrypted.toString('utf8').slice(4)].reverse().join('')
  }
}

/** In-memory key/value store matching SettingsStore's interface. */
export class MemoryStore {
  readonly data = new Map<string, string>()
  get(key: string): string | null {
    return this.data.get(key) ?? null
  }
  set(key: string, value: string): void {
    this.data.set(key, value)
  }
  delete(key: string): void {
    this.data.delete(key)
  }
}
