import type { Clock } from '../../../src/main/providers'

/** A clock whose sleeps return at once and move time forward, so waits can be asserted exactly. */
export class FakeClock implements Clock {
  readonly sleeps: number[] = []
  constructor(public time = Date.UTC(2026, 10, 13, 12, 0, 0)) {}
  now(): number {
    return this.time
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms)
    this.time += ms
  }
}

/**
 * A scheduling clock for tests: a fixed time in a fixed zone that moves only when told. Like the
 * app's clock, it never reads before the latest stored moment.
 */
export class FakeAppClock {
  private highWater = 0
  constructor(
    public time = Date.UTC(2026, 10, 14, 15, 0, 0),
    public zone = 'America/New_York'
  ) {}
  now(): number {
    return Math.max(this.time, this.highWater)
  }
  timeZone(): string {
    return this.zone
  }
  recordWrite(at: number): void {
    this.highWater = Math.max(this.highWater, at)
  }
  behindMs(): number {
    return Math.max(0, this.highWater - this.time)
  }
  /** Moves forward by whole days (backwards for negative n, as a system clock that moved back). */
  advanceDays(n: number): void {
    this.time += n * 86_400_000
  }
}
