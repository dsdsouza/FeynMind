import type { OutlineEntry, TextLine } from './types'

// Turns a document's outline or headings into section starts, and infers printed page numbers.

/** Where a section starts. Sections run until the next start. */
export interface SectionStart {
  chapter: string | null
  section: string | null
  startPage: number
  /** Measured down from the top of the page; lines at or below this height belong to the section. */
  startY: number
}

/** A page as stored after extraction. */
export interface StoredPage {
  index: number
  height: number
  lines: TextLine[]
}

/** Running heads and page numbers live in these bands at the top and bottom of a page. */
const TOP_MARGIN = 0.075
const BOTTOM_MARGIN = 0.95

/**
 * Section starts from an outline: level 1 entries are chapters, level 2 entries are sections
 * within the current chapter. Anything before the first entry is one untitled section.
 */
export function sectionsFromOutline(outline: OutlineEntry[]): SectionStart[] {
  const entries = [...outline].sort((a, b) => a.page - b.page || a.y - b.y)
  const starts: SectionStart[] = []
  let chapter: string | null = null
  for (const entry of entries) {
    if (entry.level <= 1) chapter = entry.title
    const start: SectionStart = {
      chapter,
      section: entry.level <= 1 ? null : entry.title,
      startPage: entry.page,
      startY: entry.y
    }
    const last = starts.at(-1)
    // A chapter and its first section often start at the same place: keep one start with both names.
    if (last && last.startPage === start.startPage && Math.abs(last.startY - start.startY) < 1) starts[starts.length - 1] = start
    else starts.push(start)
  }
  const first = starts[0]
  if (!first || first.startPage > 1 || first.startY > 1) starts.unshift({ chapter: null, section: null, startPage: 1, startY: 0 })
  return starts
}

/** An outline is worth using when it points to at least two different places. */
export function isUsableOutline(outline: OutlineEntry[]): boolean {
  return new Set(outline.map((e) => `${e.page}:${Math.round(e.y)}`)).size >= 2
}

/** The typical body text size: the median line size, weighted by characters. */
export function bodyFontSize(pages: StoredPage[]): number | null {
  const sizes: { size: number; weight: number }[] = []
  for (const page of pages) {
    for (const line of page.lines) sizes.push({ size: line.size, weight: line.text.length })
  }
  if (sizes.length === 0) return null
  sizes.sort((a, b) => a.size - b.size)
  const total = sizes.reduce((n, s) => n + s.weight, 0)
  let seen = 0
  for (const s of sizes) {
    seen += s.weight
    if (seen * 2 >= total) return s.size
  }
  return sizes.at(-1)?.size ?? null
}

const CHAPTER_PATTERN = /^(chapter|unit|part|lecture|module|appendix)\s+(\d+|[ivxlc]+|[a-z])\b/i
// "1.2 Title". PDF text sometimes has a space inside the number ("1. 2 Title").
const NUMBERED_SECTION = /^\d+(\.\s?\d+)+\.?\s+\p{L}/u
const CAPTION = /^(figure|fig\.|table|example|exercise|problem|solution|note|definition|theorem|proof)\b/i

/** How headings are recognized in a document without an outline. */
export interface HeadingStyle {
  bodySize: number
  /** When the document numbers its sections ("1.2 Domain and Range"), only numbered headings start sections. */
  numbered: boolean
}

/**
 * Decides the heading style from a sample of pages. The style must be fixed from the first pages
 * read, so that the sections found on a page never change as more pages are read.
 */
export function headingStyleOf(sample: StoredPage[]): HeadingStyle | null {
  const bodySize = bodyFontSize(sample)
  if (bodySize === null) return null
  let numbered = 0
  for (const page of sample) {
    for (const line of contentLines(page, bodySize)) {
      if (NUMBERED_SECTION.test(line.text) && headingLevel(line, bodySize, false) === 2) numbered++
    }
  }
  return { bodySize, numbered: numbered >= 2 }
}

/** Finds chapter and section headings by their size, position and numbering, for documents without an outline. */
export function detectHeadings(pages: StoredPage[], style: HeadingStyle): SectionStart[] {
  return withLeadingStart(findHeadings(pages, style, null))
}

/** Adds an untitled start at the top of page 1 when the first heading comes later. */
export function withLeadingStart(starts: SectionStart[]): SectionStart[] {
  const first = starts[0]
  return !first || first.startPage > 1 ? [{ chapter: null, section: null, startPage: 1, startY: 0 }, ...starts] : starts
}

/**
 * The headings on the given pages, in order. `chapter` is the chapter in force before the first of
 * them, so a long document can be scanned a few pages at a time.
 */
export function findHeadings(pages: StoredPage[], style: HeadingStyle, chapter: string | null): SectionStart[] {
  const { bodySize } = style
  const starts: SectionStart[] = []
  for (const page of pages) {
    const lines = contentLines(page, bodySize)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      const level = headingLevel(line, bodySize, style.numbered)
      if (level === null) continue
      // A heading that wraps onto a second line of the same size.
      let title = line.text
      const next = lines[i + 1]
      if (next && !NUMBERED_SECTION.test(next.text) && !CHAPTER_PATTERN.test(next.text) && headingLevel(next, bodySize, false) !== null && Math.abs(next.size - line.size) < 0.5 && next.y - line.y < line.size * 1.6) {
        title = `${title} ${next.text}`
        i++
      }
      if (level === 1) chapter = title
      starts.push({ chapter, section: level === 1 ? null : title, startPage: page.index, startY: Math.max(0, line.y - line.size * 1.2) })
    }
  }
  return starts
}

function headingLevel(line: TextLine, bodySize: number, numberedOnly: boolean): 1 | 2 | null {
  const words = line.text.split(' ').length
  if (words > 14 || !/\p{L}/u.test(line.text) || CAPTION.test(line.text)) return null
  if (/[.,;:]$/.test(line.text) && !NUMBERED_SECTION.test(line.text)) return null
  const ratio = line.size / bodySize
  if (CHAPTER_PATTERN.test(line.text) && ratio >= 1.1) return 1
  if (ratio >= 1.8) return 1
  const numbered = NUMBERED_SECTION.test(line.text)
  if (numberedOnly && !numbered) return null
  if (ratio >= 1.25) return 2
  if (numbered && line.bold) return 2
  return null
}

/**
 * The lines of a page without running heads, page numbers and footers: short lines in the top and
 * bottom margins that are no larger than body text.
 */
export function contentLines(page: StoredPage, bodySize: number | null): TextLine[] {
  if (page.height <= 0) return page.lines
  return page.lines.filter((line) => {
    // Transcribed lines never include running heads or page numbers (the prompt leaves them out).
    if (line.original !== undefined) return true
    const inMargin = line.y < page.height * TOP_MARGIN || line.y > page.height * BOTTOM_MARGIN
    if (!inMargin) return true
    const small = bodySize === null || line.size <= bodySize * 1.15
    return !(small && line.text.split(' ').length <= 14)
  })
}

/** Section starts every `everyPages` pages within long stretches that have no heading, so they become searchable sooner. */
export function splitLongSections(starts: SectionStart[], pageCount: number, everyPages: number): SectionStart[] {
  const result: SectionStart[] = []
  starts.forEach((start, i) => {
    result.push(start)
    const end = starts[i + 1]?.startPage ?? pageCount + 1
    for (let page = start.startPage + everyPages; page < end; page += everyPages) {
      result.push({ ...start, startPage: page, startY: 0 })
    }
  })
  return result
}

/**
 * Infers printed page numbers for a PDF that has no page labels, from numbers printed in the top
 * and bottom margins. A page gets a number only when nearby pages agree on the same offset between
 * printed number and position, so a stray number in a running head is not taken for a page number.
 */
export function inferPageLabels(pages: StoredPage[]): Map<number, string> {
  const offsets = new Map<number, Set<number>>()
  for (const page of pages) {
    const found = new Set<number>()
    for (const line of page.lines) {
      const inMargin = line.y < page.height * (TOP_MARGIN + 0.03) || line.y > page.height * (BOTTOM_MARGIN - 0.03)
      if (!inMargin) continue
      const tokens = line.text.split(' ')
      for (const token of [tokens[0], tokens.at(-1)]) {
        if (token && /^\d{1,4}$/.test(token)) found.add(Number(token) - page.index)
      }
    }
    offsets.set(page.index, found)
  }

  const WINDOW = 8
  const labels = new Map<number, string>()
  for (const page of pages) {
    const support = new Map<number, number>()
    for (let i = page.index - WINDOW; i <= page.index + WINDOW; i++) {
      for (const offset of offsets.get(i) ?? []) support.set(offset, (support.get(offset) ?? 0) + 1)
    }
    let best: number | null = null
    let bestSupport = 0
    for (const [offset, count] of support) {
      if (count > bestSupport) {
        best = offset
        bestSupport = count
      }
    }
    if (best === null || page.index + best < 1) continue
    const ownEvidence = offsets.get(page.index)?.has(best) ?? false
    if ((ownEvidence && bestSupport >= 3) || bestSupport >= 5) labels.set(page.index, String(page.index + best))
  }
  return labels
}
