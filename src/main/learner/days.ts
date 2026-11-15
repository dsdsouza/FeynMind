// Study days. Scheduling works in whole days, and a study day runs from 04:00 to 04:00 local time,
// so a session that goes past midnight still counts as the same day. A study day is written as
// 'YYYY-MM-DD'. Instants are converted with Intl in the time zone in effect when it matters, so
// daylight-saving changes need no special handling, and a review keeps the study day it was
// given even if the zone changes later.

/** The hour (local time) a new study day starts. */
export const DAY_START_HOUR = 4
const DAY_MS = 86_400_000

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    formatters.set(zone, f)
  }
  return f
}

/** Whether `zone` is a time zone Intl knows. */
export function isValidZone(zone: string): boolean {
  try {
    formatter(zone)
    return true
  } catch {
    return false
  }
}

/** Local calendar fields of an instant in a zone. */
function localParts(instant: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = formatter(zone).formatToParts(new Date(instant))
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }
}

/** How far the zone is ahead of UTC at an instant, in milliseconds. */
function offsetMs(instant: number, zone: string): number {
  const p = localParts(instant, zone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000
}

const pad = (n: number): string => String(n).padStart(2, '0')
const dayString = (year: number, month: number, day: number): string => `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`

/** The study day an instant belongs to, in a zone. */
export function studyDay(instant: number, zone: string): string {
  const p = localParts(instant, zone)
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day) - (p.hour < DAY_START_HOUR ? DAY_MS : 0))
  return dayString(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

/** The instant a study day starts (04:00 local on that date), in a zone. */
export function dayStart(day: string, zone: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const wall = Date.UTC(y, m - 1, d, DAY_START_HOUR)
  // Two rounds find the offset in effect at that wall-clock time, even across a change.
  let guess = wall - offsetMs(wall, zone)
  guess = wall - offsetMs(guess, zone)
  return guess
}

/** The study day `n` days after `day` (before, for negative n). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS)
  return dayString(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayToDate(to).getTime() - dayToDate(from).getTime()) / DAY_MS)
}

/**
 * The fixed instant that stands for a study day in scheduling arithmetic: noon UTC on that date.
 * The scheduler only ever sees these, so its intervals are whole study days whatever the zone.
 */
export function dayToDate(day: string): Date {
  return new Date(`${day}T12:00:00.000Z`)
}

/** The study day a scheduling instant (from dayToDate) stands for. */
export function dateToDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Whether a string is a real 'YYYY-MM-DD' date. */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = dayToDate(value)
  return !Number.isNaN(date.getTime()) && dateToDay(date) === value
}
