import type { PageRef } from '../../shared/ingestion'
import type { Result } from '../../shared/ipc'

export const api = window.feynmind

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

/** "p. 22 (PDF 5)", "pp. 22–23 (PDF 5–6)", or "slide 3" for decks. */
export function formatPages(start: PageRef, end: PageRef, kind: 'pdf' | 'pptx' = 'pdf'): string {
  if (kind === 'pptx') return start.index === end.index ? `slide ${start.index}` : `slides ${start.index}–${end.index}`
  const pdf = start.index === end.index ? `PDF ${start.index}` : `PDF ${start.index}–${end.index}`
  if (start.label === null) return start.index === end.index ? `page ${start.index}` : `pages ${start.index}–${end.index}`
  const printed = start.index === end.index || start.label === end.label ? `p. ${start.label}` : `pp. ${start.label}–${end.label ?? '?'}`
  return `${printed} (${pdf})`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Dollars, or a dash when the price is unknown. Small amounts keep enough digits to compare. */
export function formatCost(usd: number | null): string {
  if (usd === null) return '—'
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

/** "Tue 17 Nov" for a study day ('YYYY-MM-DD'). */
export function formatDay(day: string): string {
  return DAY_FORMAT.format(new Date(`${day}T12:00:00Z`))
}
