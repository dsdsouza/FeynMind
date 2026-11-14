import type { ModelInfo } from '../../../src/shared/ipc'
import type { AdapterFactory, AdapterOptions, Encryptor, GenerateRequest, GenerateResult, ProviderAdapter } from '../../../src/main/providers'

export function model(id: string): ModelInfo {
  return { id, displayName: id, description: '', inputTokenLimit: null, outputTokenLimit: null }
}

/** A scripted answer: a reply (text and optional usage) or an error to throw. */
export type FakeAnswer = { text: string; inputTokens?: number; outputTokens?: number; thinkingTokens?: number } | Error

/**
 * A provider that never touches the network. Records every call so tests can assert on them.
 * `generate` answers from `queue` first, then from `respond`, then with `reply`.
 */
export class FakeProvider {
  models: ModelInfo[] = [model('fake-pro'), model('gemini-3.5-flash-lite')]
  reply = 'Hello from the fake model.'
  failWith: Error | null = null
  queue: FakeAnswer[] = []
  respond: ((request: GenerateRequest) => FakeAnswer) | null = null
  readonly calls: { method: 'listModels' | 'generate'; apiKey: string; modelId?: string; prompt?: string; request?: GenerateRequest }[] = []

  get generateCalls(): GenerateRequest[] {
    return this.calls.filter((c) => c.method === 'generate').map((c) => c.request as GenerateRequest)
  }

  private answer(request: GenerateRequest): GenerateResult {
    const next = this.queue.shift() ?? this.respond?.(request) ?? { text: this.reply }
    if (next instanceof Error) throw next
    const inputTokens = next.inputTokens ?? Math.ceil(request.prompt.length / 4)
    const thinkingTokens = next.thinkingTokens ?? 0
    const outputTokens = (next.outputTokens ?? Math.ceil(next.text.length / 4)) + thinkingTokens
    return { text: next.text, usage: { inputTokens, outputTokens, thinkingTokens } }
  }

  readonly factory: AdapterFactory = (options: AdapterOptions): ProviderAdapter => ({
    id: 'gemini',
    listModels: async () => {
      this.calls.push({ method: 'listModels', apiKey: options.apiKey })
      if (this.failWith) throw this.failWith
      return this.models
    },
    generate: async (request) => {
      this.calls.push({ method: 'generate', apiKey: options.apiKey, modelId: request.modelId, prompt: request.prompt, request })
      if (this.failWith) throw this.failWith
      return this.answer(request)
    },
    // Streams the same answers in pieces of `streamPiece` characters. `streamFailAfter` makes the
    // next stream throw that error after its first piece, as a connection dropped mid-reply would.
    stream: async (request, onText) => {
      this.calls.push({ method: 'generate', apiKey: options.apiKey, modelId: request.modelId, prompt: request.prompt, request })
      if (this.failWith) throw this.failWith
      const result = this.answer(request)
      const pieces = result.text.match(new RegExp(`[\\s\\S]{1,${this.streamPiece}}`, 'g')) ?? []
      for (const [i, piece] of pieces.entries()) {
        onText(piece)
        if (i === 0 && this.streamFailAfter) {
          const error = this.streamFailAfter
          this.streamFailAfter = null
          throw error
        }
        await Promise.resolve()
      }
      return result
    }
  })

  streamPiece = 8
  streamFailAfter: Error | null = null
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
