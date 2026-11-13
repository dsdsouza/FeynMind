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
