import { describe, expect, it } from 'vitest'
import { InvalidOutputError, PauseError, ProviderError, ProviderService, UsageStore, type ModelTask } from '../../src/main/providers'
import { openDatabase, SessionStore, SettingsStore } from '../../src/main/storage'
import { FakeClock } from './fakes/fakeClock'
import { FakeEncryptor, FakeProvider } from './fakes/fakeProvider'

function setup(model = 'gemini-3.1-flash-lite') {
  const db = openDatabase(':memory:')
  const sessions = new SessionStore(db)
  const session = sessions.current()
  const settings = new SettingsStore(db)
  settings.set('provider.gemini.model', model)
  const provider = new FakeProvider()
  const clock = new FakeClock()
  const usage = new UsageStore(db)
  const service = new ProviderService({
    settings,
    encryptor: new FakeEncryptor(),
    createAdapter: provider.factory,
    devKey: 'dev-key',
    loadPrompt: () => '',
    usage,
    limits: (id) => sessions.limits(id),
    clock
  })
  return { db, sessions, session, settings, provider, clock, usage, service }
}

function task(sessionId: number, overrides: Partial<ModelTask<{ n: number }>> = {}): ModelTask<{ n: number }> {
  return {
    role: 'ingestion',
    sessionId,
    jobId: null,
    prompt: { name: 'test-prompt', version: 1, hash: 'h1' },
    text: 'Count to one.',
    thinking: 'minimal',
    maxOutputTokens: 100,
    contentKey: 'content-1',
    estimate: { inputTokens: 10, outputTokens: 5 },
    parse: (text) => {
      const value = JSON.parse(text) as { n?: unknown }
      if (typeof value.n !== 'number') throw new InvalidOutputError('n must be a number')
      return { n: value.n }
    },
    ...overrides
  }
}

describe('ProviderService.run', () => {
  it('calls once, caches the valid reply, and answers the same task from the cache', async () => {
    const { service, provider, session } = setup()
    provider.reply = '{"n":1}'
    expect(await service.run(task(session.id))).toEqual({ value: { n: 1 }, cached: false })
    expect(await service.run(task(session.id))).toEqual({ value: { n: 1 }, cached: true })
    expect(provider.generateCalls).toHaveLength(1)
    const summary = service.usageSummary(session.id)
    expect(summary).toMatchObject({ calls: 1, cacheHits: 1, requests: 1 })
  })

  it('misses the cache when the prompt, the content or the model changes', async () => {
    const { service, provider, session, settings } = setup()
    provider.reply = '{"n":1}'
    await service.run(task(session.id))
    await service.run(task(session.id, { prompt: { name: 'test-prompt', version: 2, hash: 'h2' } }))
    await service.run(task(session.id, { contentKey: 'content-2' }))
    settings.set('provider.gemini.model', 'other-model')
    await service.run(task(session.id))
    expect(provider.generateCalls).toHaveLength(4)
    // A different prompt's results are untouched by the change.
    settings.set('provider.gemini.model', 'gemini-3.1-flash-lite')
    await service.run(task(session.id, { prompt: { name: 'other-prompt', version: 1, hash: 'x' } }))
    await service.run(task(session.id))
    expect(provider.generateCalls).toHaveLength(5)
  })

  it('rejects malformed replies, retries, and never stores them', async () => {
    const { service, provider, session, usage } = setup()
    provider.queue = [{ text: 'garbage' }, { text: '{"n":"one"}' }, { text: '{"n":2}' }]
    const result = await service.run(task(session.id, { parse: (t) => {
      let value: { n?: unknown }
      try { value = JSON.parse(t) as { n?: unknown } } catch { throw new InvalidOutputError('not JSON') }
      if (typeof value.n !== 'number') throw new InvalidOutputError('n must be a number')
      return { n: value.n }
    } }))
    expect(result.value).toEqual({ n: 2 })
    expect(provider.generateCalls).toHaveLength(3)
    // Invalid replies were billed, so they count as calls.
    expect(usage.sessionTotals(session.id).calls).toBe(3)
  })

  it('fails after three invalid replies without caching anything', async () => {
    const { service, provider, session } = setup()
    provider.reply = '{"n":"never a number"}'
    await expect(service.run(task(session.id))).rejects.toBeInstanceOf(InvalidOutputError)
    expect(provider.generateCalls).toHaveLength(3)
    provider.reply = '{"n":3}'
    expect((await service.run(task(session.id))).cached).toBe(false)
  })

  it('pauses at the call cap before sending', async () => {
    const { service, provider, session, sessions } = setup()
    sessions.setLimits(session.id, { callCap: 1, spendCapUsd: null })
    provider.reply = '{"n":1}'
    await service.run(task(session.id))
    const error = await service.run(task(session.id, { contentKey: 'other' })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PauseError)
    expect((error as PauseError).reason).toBe('cap')
    expect(provider.generateCalls).toHaveLength(1)
    // Cached results are free and still allowed.
    expect((await service.run(task(session.id))).cached).toBe(true)
  })

  it('pauses before a call that would pass the spending cap', async () => {
    const { service, provider, session, sessions } = setup()
    // gemini-3.1-flash-lite: $0.25 in, $1.50 out per million. One million input tokens estimated = $0.25.
    sessions.setLimits(session.id, { callCap: null, spendCapUsd: 0.2 })
    provider.reply = '{"n":1}'
    const error = await service.run(task(session.id, { estimate: { inputTokens: 1_000_000, outputTokens: 0 } })).catch((e: unknown) => e)
    expect((error as PauseError).reason).toBe('cap')
    expect(provider.generateCalls).toHaveLength(0)
  })

  it('records refused requests and pauses on an exhausted daily quota', async () => {
    const { service, provider, session, usage } = setup()
    provider.queue = [new ProviderError('limit', 'rate-limit', 1000), new ProviderError('daily', 'quota-daily')]
    const error = await service.run(task(session.id)).catch((e: unknown) => e)
    expect((error as PauseError).reason).toBe('quota')
    const totals = usage.sessionTotals(session.id)
    expect(totals).toMatchObject({ calls: 0, requests: 2 })
  })

  it('prices usage per model and reports unknown prices as null', async () => {
    const { service, provider, session, settings } = setup()
    provider.queue = [{ text: '{"n":1}', inputTokens: 1_000_000, outputTokens: 1_000_000 }]
    await service.run(task(session.id))
    expect(service.usageSummary(session.id).costUsd).toBeCloseTo(1.75)
    settings.set('provider.gemini.model', 'unknown-model')
    provider.queue = [{ text: '{"n":1}', inputTokens: 10, outputTokens: 10 }]
    await service.run(task(session.id))
    expect(service.usageSummary(session.id).costUsd).toBeNull()
    service.setPrice('unknown-model', { input: 1, output: 2 })
    expect(service.usageSummary(session.id).costUsd).toBeCloseTo(1.75 + 0.00003)
  })

  it('calibrates from recorded estimates', async () => {
    const { service, provider, session } = setup()
    provider.queue = [{ text: '{"n":1}', inputTokens: 20, outputTokens: 10 }]
    await service.run(task(session.id))
    expect(service.calibration('ingestion', 'test-prompt')).toEqual({ inputFactor: 2, outputFactor: 2, samples: 1 })
  })

  it('calibrates against the uncalibrated estimate, so a correction that worked is kept', async () => {
    const { service, provider, session } = setup()
    // The formula says 10 and 5; calibration already doubled it, and the call used exactly that.
    provider.queue = [{ text: '{"n":1}', inputTokens: 20, outputTokens: 10 }]
    await service.run(task(session.id, { estimate: { inputTokens: 20, outputTokens: 10 }, uncalibratedEstimate: { inputTokens: 10, outputTokens: 5 } }))
    expect(service.calibration('ingestion', 'test-prompt')).toEqual({ inputFactor: 2, outputFactor: 2, samples: 1 })
  })
})
