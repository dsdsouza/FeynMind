import { describe, expect, it } from 'vitest'
import { PauseError, ProviderError } from '../../src/main/providers'
import { backoffMs, nextPacificMidnight, RateLimiter, withRetries } from '../../src/main/providers/rateLimiter'
import { FakeClock } from './fakes/fakeClock'

const half = (): number => 0.5 // no jitter

describe('RateLimiter', () => {
  it('spaces requests to stay under the per-minute limit', async () => {
    const clock = new FakeClock()
    const limiter = new RateLimiter(() => 2, clock)
    const started: number[] = []
    for (let i = 0; i < 5; i++) await limiter.run(async () => started.push(clock.now()))
    const t0 = started[0] ?? 0
    expect(started.map((t) => t - t0)).toEqual([0, 0, 60_000, 60_000, 120_000])
  })

  it('runs one request at a time, in order', async () => {
    const clock = new FakeClock()
    const limiter = new RateLimiter(() => 100, clock)
    const log: string[] = []
    let release: () => void = () => undefined
    const first = limiter.run(() => new Promise<void>((r) => (release = () => { log.push('first done'); r() })))
    const second = limiter.run(async () => log.push('second'))
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
    expect(log).toEqual([])
    release()
    await Promise.all([first, second])
    expect(log).toEqual(['first done', 'second'])
  })

  it('holds every request after a limit error', async () => {
    const clock = new FakeClock()
    const limiter = new RateLimiter(() => 100, clock)
    limiter.holdFor(30_000)
    const start = clock.now()
    await limiter.run(async () => undefined)
    expect(clock.now() - start).toBe(30_000)
  })
})

describe('withRetries', () => {
  it('waits the delay the provider asks for, then succeeds', async () => {
    const clock = new FakeClock()
    const limiter = new RateLimiter(() => 100, clock)
    const errors = [new ProviderError('limit', 'rate-limit', 21_000)]
    const failures: string[] = []
    const result = await withRetries(limiter, async () => {
      const e = errors.shift()
      if (e) throw e
      return 'ok'
    }, { clock, random: half, onFailedAttempt: (o) => failures.push(o.kind) })
    expect(result).toBe('ok')
    expect(clock.sleeps).toEqual([21_000])
    expect(failures).toEqual(['rate-limit'])
  })

  it('backs off exponentially when no delay is given, then pauses after repeated limits', async () => {
    const clock = new FakeClock()
    const limiter = new RateLimiter(() => 100, clock)
    let attempts = 0
    const error = await withRetries(limiter, async () => {
      attempts++
      throw new ProviderError('limit', 'rate-limit')
    }, { clock, random: half }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PauseError)
    expect((error as PauseError).reason).toBe('rate-limit')
    expect((error as PauseError).resumeAt).not.toBeNull()
    expect(attempts).toBe(7)
    expect(clock.sleeps).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 120_000])
  })

  it('pauses until the Pacific midnight reset when the daily quota is used up, without retrying', async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 13, 12, 0, 0))
    const limiter = new RateLimiter(() => 100, clock)
    let attempts = 0
    const error = (await withRetries(limiter, async () => {
      attempts++
      throw new ProviderError('daily', 'quota-daily')
    }, { clock }).catch((e: unknown) => e)) as PauseError
    expect(attempts).toBe(1)
    expect(error.reason).toBe('quota')
    // 2026-11-14 00:00 PST is 08:00 UTC; one minute of margin.
    expect(error.resumeAt?.toISOString()).toBe('2026-11-14T08:01:00.000Z')
  })

  it('retries overload errors a few times, then pauses', async () => {
    const clock = new FakeClock()
    const limiter = new RateLimiter(() => 100, clock)
    let attempts = 0
    const error = await withRetries(limiter, async () => {
      attempts++
      throw new ProviderError('busy', 'overloaded')
    }, { clock, random: half }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PauseError)
    expect(attempts).toBe(5)
  })

  it('does not retry errors that retrying cannot fix', async () => {
    const clock = new FakeClock()
    const limiter = new RateLimiter(() => 100, clock)
    let attempts = 0
    await expect(withRetries(limiter, async () => {
      attempts++
      throw new ProviderError('bad key', 'auth')
    }, { clock })).rejects.toThrow('bad key')
    expect(attempts).toBe(1)
  })
})

describe('time helpers', () => {
  it('caps the backoff at two minutes', () => {
    expect(backoffMs(1, half)).toBe(5_000)
    expect(backoffMs(20, half)).toBe(120_000)
  })

  it('finds the next Pacific midnight in summer time too', () => {
    // 2026-07-01 12:00 UTC is 05:00 PDT; the next midnight PDT is 07:00 UTC on 2026-07-02.
    expect(nextPacificMidnight(new Date(Date.UTC(2026, 6, 1, 12))).toISOString()).toBe('2026-07-02T07:01:00.000Z')
    // Just before midnight PST on 2026-11-13 (07:59 UTC on the 14th is 23:59 PST on the 13th).
    expect(nextPacificMidnight(new Date(Date.UTC(2026, 10, 14, 7, 59))).toISOString()).toBe('2026-11-14T08:01:00.000Z')
  })
})
