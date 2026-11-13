import { ProviderError, type ProviderErrorKind } from './types'

// Pacing and retrying for model requests. Free-tier keys allow only a few requests a minute, so
// requests go out one at a time, spaced to stay under a requests-per-minute limit, and the
// provider's own limit errors decide how long to wait.

export interface Clock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Stopped.'))
        return
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Stopped.'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
}

/** Why a job has to stop for now. Not a failure: the job continues from the same step later. */
export class PauseError extends Error {
  override readonly name = 'PauseError'
  constructor(
    message: string,
    readonly reason: 'cap' | 'quota' | 'rate-limit' | 'provider',
    /** When it is worth trying again on its own, or null to wait for the user. */
    readonly resumeAt: Date | null
  ) {
    super(message)
  }
}

/** Sends one request at a time, at most `rpm()` per rolling minute, and honours holds after limit errors. */
export class RateLimiter {
  private tail: Promise<unknown> = Promise.resolve()
  private recent: number[] = []
  private heldUntil = 0

  constructor(
    private readonly rpm: () => number,
    private readonly clock: Clock = realClock
  ) {}

  /** Stops every request (including queued ones) until `ms` from now. */
  holdFor(ms: number): void {
    this.heldUntil = Math.max(this.heldUntil, this.clock.now() + ms)
  }

  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.tail.then(async () => {
      await this.waitForSlot(signal)
      this.recent.push(this.clock.now())
      return fn()
    })
    // The next request waits for this one to finish, whether it succeeded or not.
    this.tail = result.catch(() => undefined)
    return result
  }

  private async waitForSlot(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = this.clock.now()
      this.recent = this.recent.filter((t) => now - t < 60_000)
      const limit = Math.max(1, Math.floor(this.rpm()))
      let wait = Math.max(0, this.heldUntil - now)
      if (this.recent.length >= limit) wait = Math.max(wait, (this.recent[0] ?? now) + 60_000 - now)
      if (wait <= 0) return
      await this.clock.sleep(wait, signal)
    }
  }
}

/** Short-term limit errors in a row before the job pauses for a while instead of retrying. */
export const MAX_RATE_LIMIT_RETRIES = 6
/** Overload, timeout and network errors in a row before the job pauses. */
export const MAX_TRANSIENT_RETRIES = 4
/** How long a job waits after giving up on repeated limit or overload errors. */
export const PAUSE_AFTER_REPEATED_ERRORS_MS = 5 * 60_000
const BACKOFF_BASE_MS = 5_000
const BACKOFF_MAX_MS = 120_000

/** Exponential backoff with ±20% jitter: about 5 s, 10 s, 20 s ... up to 120 s. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1))
  return Math.round(base * (0.8 + 0.4 * random()))
}

/** The next midnight in Pacific time, when Gemini's daily quotas reset, plus a minute of margin. */
export function nextPacificMidnight(now: Date): Date {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now)
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
  // Midnight Pacific is 08:00 UTC in winter (PST) and 07:00 UTC in summer (PDT).
  let candidate = new Date(Date.UTC(part('year'), part('month') - 1, part('day') + 1, 8, 1))
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(candidate))
  if (hour === 1) candidate = new Date(candidate.getTime() - 3_600_000)
  return candidate
}

export type AttemptOutcome = { kind: ProviderErrorKind | 'other' }

/**
 * Runs `send` through the limiter, retrying limit and transient errors. Throws a PauseError when
 * the daily quota is used up or errors keep coming; rethrows anything retrying cannot fix.
 * `onFailedAttempt` is told about every failed attempt so it can be recorded.
 */
export async function withRetries<T>(
  limiter: RateLimiter,
  send: () => Promise<T>,
  options: { clock?: Clock; signal?: AbortSignal; onFailedAttempt?: (outcome: AttemptOutcome) => void; random?: () => number } = {}
): Promise<T> {
  const clock = options.clock ?? realClock
  let limited = 0
  let transient = 0
  for (;;) {
    try {
      return await limiter.run(send, options.signal)
    } catch (error) {
      if (!(error instanceof ProviderError)) {
        options.onFailedAttempt?.({ kind: 'other' })
        throw error
      }
      options.onFailedAttempt?.({ kind: error.kind })
      if (error.kind === 'quota-daily') {
        const resumeAt = nextPacificMidnight(new Date(clock.now()))
        throw new PauseError(error.message, 'quota', resumeAt)
      }
      if (error.kind === 'rate-limit') {
        limited++
        if (limited > MAX_RATE_LIMIT_RETRIES) {
          throw new PauseError('The provider kept refusing requests because of its rate limit.', 'rate-limit', new Date(clock.now() + PAUSE_AFTER_REPEATED_ERRORS_MS))
        }
        limiter.holdFor(error.retryAfterMs ?? backoffMs(limited, options.random))
        continue
      }
      if (error.kind === 'overloaded' || error.kind === 'timeout' || error.kind === 'network') {
        transient++
        if (transient > MAX_TRANSIENT_RETRIES) {
          throw new PauseError(`${error.message} It kept happening, so the job paused.`, 'provider', new Date(clock.now() + PAUSE_AFTER_REPEATED_ERRORS_MS))
        }
        limiter.holdFor(backoffMs(transient, options.random))
        continue
      }
      throw error
    }
  }
}
