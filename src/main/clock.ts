// The clock that all review scheduling reads. Nothing that schedules reads the system time
// directly: tests give it a fake system time, and in development the app's date can be moved
// forward to try several weeks in minutes. It never goes back before the latest moment scheduling
// stored something, so a system clock that moves backwards cannot reorder reviews.

const HIGH_WATER_KEY = 'clock.highWater'
const DEV_OFFSET_KEY = 'dev.clockOffsetMs'
/** A system clock further behind the latest stored moment than this is reported to the learner. */
const BEHIND_NOTICE_MS = 5 * 60_000

export interface KeyValue {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
}

/** What scheduling needs from a clock. */
export interface AppClock {
  /** Milliseconds since the epoch: never before the latest moment scheduling stored something. */
  now(): number
  /** The time zone study days are counted in. */
  timeZone(): string
  /** Notes that scheduling stored something at `at`, so later readings never go back before it. */
  recordWrite(at: number): void
}

export interface SchedulingClockOptions {
  settings: KeyValue
  /** The system time; injected in tests. */
  system?: () => number
  /** The system time zone at startup; the window reports changes later. */
  systemZone?: () => string
  /** Whether the development date control works. False in packaged builds, always. */
  allowDevOffset: boolean
  /** A fixed offset in days for end-to-end tests (development builds only); overrides the saved one. */
  envOffsetDays?: number | null
}

export class SchedulingClock implements AppClock {
  private readonly system: () => number
  private zone: string
  private highWater: number

  constructor(private readonly options: SchedulingClockOptions) {
    this.system = options.system ?? (() => Date.now())
    this.zone = (options.systemZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone))()
    this.highWater = Number(options.settings.get(HIGH_WATER_KEY) ?? 0) || 0
  }

  /** The system time moved by the development offset, if any. */
  private shifted(): number {
    return this.system() + this.devOffsetMs()
  }

  now(): number {
    return Math.max(this.shifted(), this.highWater)
  }

  timeZone(): string {
    return this.zone
  }

  /** Called when the window reports its time zone (Node keeps the zone it started with). */
  setTimeZone(zone: string): boolean {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone })
    } catch {
      return false
    }
    if (zone === this.zone) return false
    this.zone = zone
    return true
  }

  recordWrite(at: number): void {
    if (at > this.highWater) {
      this.highWater = at
      this.options.settings.set(HIGH_WATER_KEY, String(at))
    }
  }

  /** How far the (shifted) system clock is behind the latest stored moment, when that is worth telling the learner; 0 otherwise. */
  behindMs(): number {
    const behind = this.highWater - this.shifted()
    return behind > BEHIND_NOTICE_MS ? behind : 0
  }

  // The development date control. Absent from packaged builds: allowDevOffset is false there.

  get devControlsAllowed(): boolean {
    return this.options.allowDevOffset
  }

  devOffsetMs(): number {
    if (!this.options.allowDevOffset) return 0
    const env = this.options.envOffsetDays
    if (env !== undefined && env !== null && Number.isFinite(env)) return Math.round(env * 86_400_000)
    return Number(this.options.settings.get(DEV_OFFSET_KEY) ?? 0) || 0
  }

  /** Moves the app's date forward by whole days (development builds only). */
  moveDays(days: number): void {
    if (!this.options.allowDevOffset) throw new Error('The date control is only available in development builds.')
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('Move the date forward by 1 to 366 days.')
    this.options.settings.set(DEV_OFFSET_KEY, String(this.devOffsetMs() + days * 86_400_000))
  }

  /** Back to the real date, forgetting the latest stored moment so the clock follows the system again (development builds only). */
  resetDev(): void {
    if (!this.options.allowDevOffset) throw new Error('The date control is only available in development builds.')
    this.options.settings.delete(DEV_OFFSET_KEY)
    this.options.settings.delete(HIGH_WATER_KEY)
    this.highWater = 0
  }
}
