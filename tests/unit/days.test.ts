import { describe, expect, it } from 'vitest'
import { SchedulingClock } from '../../src/main/clock'
import { addDays, dateToDay, dayStart, daysBetween, dayToDate, isDay, studyDay } from '../../src/main/learner/days'

const NY = 'America/New_York'
const TOKYO = 'Asia/Tokyo'
const at = (iso: string) => Date.parse(iso)

describe('study days', () => {
  it('start at 04:00 local time, so a late session counts as the day before', () => {
    // 03:59 and 04:00 New York time on 15 November (EST, UTC-5).
    expect(studyDay(at('2026-11-15T08:59:00Z'), NY)).toBe('2026-11-14')
    expect(studyDay(at('2026-11-15T09:00:00Z'), NY)).toBe('2026-11-15')
    // 23:30 the same evening is still 15 November; 01:00 after midnight too.
    expect(studyDay(at('2026-11-16T04:30:00Z'), NY)).toBe('2026-11-15')
    expect(studyDay(at('2026-11-16T06:00:00Z'), NY)).toBe('2026-11-15')
  })

  it('find the start of a day across daylight-saving changes', () => {
    // EDT (UTC-4) before 1 November 2026, EST (UTC-5) after; 8 March 2026 back to EDT.
    expect(new Date(dayStart('2026-10-31', NY)).toISOString()).toBe('2026-10-31T08:00:00.000Z')
    expect(new Date(dayStart('2026-11-01', NY)).toISOString()).toBe('2026-11-01T09:00:00.000Z')
    expect(new Date(dayStart('2026-03-08', NY)).toISOString()).toBe('2026-03-08T08:00:00.000Z')
    // The day of the change is 25 hours long; every instant in it belongs to it.
    for (let t = dayStart('2026-11-01', NY); t < dayStart('2026-11-02', NY); t += 15 * 60_000) expect(studyDay(t, NY)).toBe('2026-11-01')
    expect(dayStart('2026-11-02', NY) - dayStart('2026-11-01', NY)).toBe(24 * 3_600_000)
    expect(dayStart('2026-11-01', NY) - dayStart('2026-10-31', NY)).toBe(25 * 3_600_000)
  })

  it('follow the zone in effect: the same instant can be a different day in Tokyo', () => {
    const instant = at('2026-11-15T20:00:00Z')
    expect(studyDay(instant, NY)).toBe('2026-11-15')
    expect(studyDay(instant, TOKYO)).toBe('2026-11-16')
  })

  it('count and add whole days, and stand for a day by noon UTC', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(daysBetween('2026-11-14', '2026-12-03')).toBe(19)
    expect(daysBetween('2026-12-03', '2026-11-14')).toBe(-19)
    expect(dayToDate('2026-11-14').toISOString()).toBe('2026-11-14T12:00:00.000Z')
    expect(dateToDay(dayToDate('2026-02-28'))).toBe('2026-02-28')
    expect(isDay('2026-02-29')).toBe(false)
    expect(isDay('2026-13-01')).toBe(false)
    expect(isDay('2028-02-29')).toBe(true)
  })
})

class MemorySettings {
  readonly values = new Map<string, string>()
  get(key: string) {
    return this.values.get(key) ?? null
  }
  set(key: string, value: string) {
    this.values.set(key, value)
  }
  delete(key: string) {
    this.values.delete(key)
  }
}

describe('scheduling clock', () => {
  it('never goes back before the latest stored moment when the system clock moves backwards', () => {
    let system = at('2026-11-15T15:00:00Z')
    const settings = new MemorySettings()
    const clock = new SchedulingClock({ settings, system: () => system, systemZone: () => NY, allowDevOffset: false })
    clock.recordWrite(clock.now())
    system -= 2 * 86_400_000
    expect(clock.now()).toBe(at('2026-11-15T15:00:00Z'))
    expect(clock.behindMs()).toBe(2 * 86_400_000)
    // The mark survives a restart.
    const restarted = new SchedulingClock({ settings, system: () => system, systemZone: () => NY, allowDevOffset: false })
    expect(restarted.now()).toBe(at('2026-11-15T15:00:00Z'))
    // Once the system catches up, it follows the system again.
    system = at('2026-11-15T16:00:00Z')
    expect(restarted.now()).toBe(system)
    expect(restarted.behindMs()).toBe(0)
  })

  it('moves the date forward only where allowed, and resets to the real date', () => {
    const system = at('2026-11-15T15:00:00Z')
    const settings = new MemorySettings()
    const packaged = new SchedulingClock({ settings, system: () => system, systemZone: () => NY, allowDevOffset: false })
    expect(() => packaged.moveDays(1)).toThrow(/development builds/)
    settings.set('dev.clockOffsetMs', String(5 * 86_400_000))
    expect(packaged.now()).toBe(system)

    settings.delete('dev.clockOffsetMs')
    const dev = new SchedulingClock({ settings, system: () => system, systemZone: () => NY, allowDevOffset: true })
    dev.moveDays(7)
    dev.moveDays(1)
    expect(studyDay(dev.now(), NY)).toBe('2026-11-23')
    dev.recordWrite(dev.now())
    dev.resetDev()
    expect(dev.now()).toBe(system)
    expect(() => dev.moveDays(0)).toThrow()

    const e2e = new SchedulingClock({ settings, system: () => system, systemZone: () => NY, allowDevOffset: true, envOffsetDays: 2 })
    expect(studyDay(e2e.now(), NY)).toBe('2026-11-17')
  })

  it('takes a time zone the window reports, refusing an unknown one', () => {
    const clock = new SchedulingClock({ settings: new MemorySettings(), system: () => 0, systemZone: () => NY, allowDevOffset: false })
    expect(clock.setTimeZone('Not/AZone')).toBe(false)
    expect(clock.setTimeZone(TOKYO)).toBe(true)
    expect(clock.timeZone()).toBe(TOKYO)
  })
})
