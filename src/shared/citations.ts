// How the tutor cites the textbook. Passages sent to the model are tagged S1, S2, ...; the model
// cites a page of one as [S2 p. 17], using the page's printed number (or the PDF page when it has
// none). The main process checks citations in structured replies; the interface turns each one
// into a link that opens the page.

import type { PageRef } from './ingestion'

/** A passage the tutor was given, as the interface needs it to open cited pages. */
export interface SourceRef {
  tag: string
  materialId: number
  fileName: string
  chapter: string | null
  section: string | null
  pages: PageRef[]
}

/** The page number a citation uses for a page. */
export function citeValue(page: PageRef): string {
  return page.label ?? String(page.index)
}

/** "S2 p. 17", without brackets. */
export function citationOf(tag: string, page: PageRef): string {
  return `${tag} p. ${citeValue(page)}`
}

const CITATION_BODY = /^(S\d+) p\. (\S(?:.*\S)?)$/

/** Splits "S2 p. 17" into its tag and page number, or null if it is not a citation. */
export function parseCitation(text: string): { tag: string; value: string } | null {
  const match = CITATION_BODY.exec(text.trim())
  return match?.[1] && match[2] ? { tag: match[1], value: match[2] } : null
}

/** The source and page a citation points to, or null when it names no page of the given sources. */
export function resolveCitation(sources: SourceRef[], text: string): { source: SourceRef; page: PageRef } | null {
  const cite = parseCitation(text)
  if (!cite) return null
  const source = sources.find((s) => s.tag === cite.tag)
  const page = source?.pages.find((p) => citeValue(p) === cite.value)
  return source && page ? { source, page } : null
}

/** Text split into plain parts and bracketed citations ([S2 p. 17]), in order. */
export function splitCitations(text: string): ({ kind: 'text'; text: string } | { kind: 'cite'; cite: string })[] {
  const parts: ({ kind: 'text'; text: string } | { kind: 'cite'; cite: string })[] = []
  const pattern = /\[(S\d+ p\. [^\]\n]{1,20})\]/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push({ kind: 'text', text: text.slice(last, match.index) })
    parts.push({ kind: 'cite', cite: match[1] ?? '' })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
  return parts
}
