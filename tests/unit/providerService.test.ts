import { describe, expect, it } from 'vitest'
import { ProviderService, redact, toUserMessage } from '../../src/main/providers'
import { openDatabase, SettingsStore } from '../../src/main/storage'
import { FakeEncryptor, FakeProvider, MemoryStore, model } from './fakes/fakeProvider'

const KEY = 'AIza-fake-key-for-tests-0001'
const PROMPT = 'Reply with one short sentence.'

function setup(opts: { devKey?: string | null; encryptor?: FakeEncryptor; settings?: MemoryStore | SettingsStore } = {}) {
  const provider = new FakeProvider()
  const settings = opts.settings ?? new MemoryStore()
  const prompts: string[] = []
  const service = new ProviderService({
    settings,
    encryptor: opts.encryptor ?? new FakeEncryptor(),
    createAdapter: provider.factory,
    devKey: opts.devKey ?? null,
    loadPrompt: (name) => {
      prompts.push(name)
      return PROMPT
    }
  })
  return { service, provider, settings, prompts }
}

describe('ProviderService keys', () => {
  it('starts with no key', () => {
    const { service } = setup()
    expect(service.getState()).toEqual({ provider: 'gemini', keySource: 'none', canStoreKey: true, selectedModel: null })
  })

  it('stores only ciphertext in the database and uses the decrypted key for calls', async () => {
    const settings = new SettingsStore(openDatabase(':memory:'))
    const { service, provider } = setup({ settings })
    expect(service.saveKey(`  ${KEY}  `).keySource).toBe('stored')

    const stored = settings.get('provider.gemini.apiKeyEncrypted')
    expect(stored).not.toBeNull()
    expect(stored).not.toContain(KEY)
    expect(Buffer.from(stored ?? '', 'base64').toString('utf8')).not.toContain(KEY)

    await service.listModels()
    expect(provider.calls[0]?.apiKey).toBe(KEY)
  })

  it('falls back to the development key only when no key is saved', async () => {
    const { service, provider } = setup({ devKey: 'dev-key' })
    expect(service.getState().keySource).toBe('env')
    await service.listModels()
    expect(provider.calls.at(-1)?.apiKey).toBe('dev-key')

    service.saveKey(KEY)
    expect(service.getState().keySource).toBe('stored')
    await service.listModels()
    expect(provider.calls.at(-1)?.apiKey).toBe(KEY)

    expect(service.clearKey().keySource).toBe('env')
  })

  it('refuses to save when secure storage is unavailable, instead of storing plain text', () => {
    const { service, settings } = setup({ encryptor: new FakeEncryptor(false) })
    expect(service.getState().canStoreKey).toBe(false)
    expect(() => service.saveKey(KEY)).toThrow(/no secure storage/)
    expect((settings as MemoryStore).data.size).toBe(0)
  })

  it('rejects empty or malformed keys', () => {
    const { service } = setup()
    expect(() => service.saveKey('   ')).toThrow('Enter an API key.')
    expect(() => service.saveKey('two words')).toThrow(/does not look like an API key/)
  })

  it('asks for a key before any model call', async () => {
    const { service, provider } = setup()
    await expect(service.listModels()).rejects.toThrow('Add a Gemini API key first.')
    expect(provider.calls).toHaveLength(0)
  })
})

describe('ProviderService models', () => {
  it('pre-selects the cheapest preferred model when none is chosen', async () => {
    const { service } = setup({ devKey: 'dev-key' })
    const models = await service.listModels()
    expect(models.map((m) => m.id)).toEqual(['fake-pro', 'gemini-3.5-flash-lite'])
    expect(service.getState().selectedModel).toBe('gemini-3.5-flash-lite')
  })

  it('falls back to the first model when no preferred model is available', async () => {
    const { service, provider } = setup({ devKey: 'dev-key' })
    provider.models = [model('only-model')]
    await service.listModels()
    expect(service.getState().selectedModel).toBe('only-model')
  })

  it('keeps an existing choice when listing again', async () => {
    const { service } = setup({ devKey: 'dev-key' })
    await service.listModels()
    service.selectModel('fake-pro')
    await service.listModels()
    expect(service.getState().selectedModel).toBe('fake-pro')
  })

  it('rejects malformed ids and models the key cannot reach', async () => {
    const { service } = setup({ devKey: 'dev-key' })
    expect(() => service.selectModel('../evil')).toThrow('Invalid model id.')
    await service.listModels()
    expect(() => service.selectModel('not-listed')).toThrow(/not available/)
  })
})

describe('ProviderService test call', () => {
  it('sends the connection-test prompt from prompts/ to the selected model, once', async () => {
    const { service, provider, prompts } = setup({ devKey: 'dev-key' })
    await service.listModels()
    const result = await service.test()

    expect(result).toMatchObject({ model: 'gemini-3.5-flash-lite', reply: 'Hello from the fake model.' })
    expect(prompts).toEqual(['connection-test'])
    const generateCalls = provider.calls.filter((c) => c.method === 'generateText')
    expect(generateCalls).toEqual([
      { method: 'generateText', apiKey: 'dev-key', modelId: 'gemini-3.5-flash-lite', prompt: PROMPT }
    ])
  })

  it('requires a chosen model', async () => {
    const { service } = setup({ devKey: 'dev-key' })
    await expect(service.test()).rejects.toThrow('Choose a model first.')
  })

  it('never lets the key through an error message', async () => {
    const { service, provider } = setup()
    service.saveKey(KEY)
    provider.failWith = new Error(`request to https://x?key=${KEY} failed for ${KEY}`)
    const error = await service.listModels().catch((e: unknown) => e)
    const message = service.safeErrorMessage(error)
    expect(message).not.toContain(KEY)
    expect(message).toContain('[redacted]')
  })
})

describe('redaction helpers', () => {
  it('redacts every occurrence and truncates long messages', () => {
    expect(redact('a SECRET b SECRET', ['SECRET'])).toBe('a [redacted] b [redacted]')
    expect(toUserMessage(new Error('x'.repeat(400)), []).length).toBeLessThanOrEqual(301)
    expect(toUserMessage('not an error', [])).toBe('Unknown error')
  })
})
