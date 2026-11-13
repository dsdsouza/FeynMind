import type { SectionStart, StoredPage } from './structure'
import { contentLines } from './structure'
import type { TextLine } from './types'

export interface ChunkDraft {
  text: string
  pageStart: number
  pageEnd: number
  /** The extracted text that transcribed lines in this chunk replaced, or null when none were transcribed. */
  originalText: string | null
}

export interface ChunkOptions {
  /** Aim for chunks of about this many words... */
  targetWords: number
  /** ...and never more than this many. */
  maxWords: number
  /** Words repeated from the end of the previous chunk, so a passage cut in two is still found whole. */
  overlapWords: number
  /** Whether to drop running heads and page numbers (PDFs) or keep every line (slides). */
  stripMargins: boolean
}

// About 250 words is roughly 330 tokens: enough context for a passage, well under the
// embedding model's 512-token limit even with the section title added.
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { targetWords: 250, maxWords: 340, overlapWords: 40, stripMargins: true }

interface Word {
  text: string
  page: number
  /** The transcribed line this word came from, when it came from one. */
  line?: TextLine
}

interface Paragraph {
  words: Word[]
}

/**
 * Splits the text of one section into chunks. `pages` must include every page the section touches;
 * lines outside the section (before `start`, or at or after `next`) are ignored.
 */
export function chunkSection(
  pages: StoredPage[],
  start: SectionStart,
  next: SectionStart | null,
  bodySize: number | null,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS
): ChunkDraft[] {
  const paragraphs = sectionParagraphs(pages, start, next, bodySize, options.stripMargins)
  return packChunks(paragraphs, options)
}

function inSection(page: number, y: number, start: SectionStart, next: SectionStart | null): boolean {
  const afterStart = page > start.startPage || (page === start.startPage && y >= start.startY)
  const beforeNext = next === null || page < next.startPage || (page === next.startPage && y < next.startY)
  return afterStart && beforeNext
}

function sectionParagraphs(
  pages: StoredPage[],
  start: SectionStart,
  next: SectionStart | null,
  bodySize: number | null,
  stripMargins: boolean
): Paragraph[] {
  const paragraphs: Paragraph[] = []
  let current: Word[] = []
  let previous: { y: number; size: number; page: number } | null = null
  const flush = (): void => {
    if (current.length > 0) paragraphs.push({ words: current })
    current = []
  }
  for (const page of [...pages].sort((a, b) => a.index - b.index)) {
    const lines = stripMargins ? contentLines(page, bodySize) : page.lines
    for (const line of lines) {
      if (!inSection(page.index, line.y, start, next)) continue
      const gap = previous && previous.page === page.index ? line.y - previous.y : 0
      const sizeChange = previous !== null && Math.abs(line.size - previous.size) > 1
      if (previous && (gap > Math.max(line.size, previous.size) * 1.8 || gap < 0 || sizeChange)) flush()
      let words = line.text.split(/\s+/)
      // Rejoin a word hyphenated across lines: "deter-" + "mine".
      const last = current.at(-1)
      if (last && /\p{L}-$/u.test(last.text) && /^\p{Ll}/u.test(words[0] ?? '')) {
        last.text = last.text.slice(0, -1) + (words[0] ?? '')
        words = words.slice(1)
      }
      for (const text of words) if (text !== '') current.push(line.original !== undefined ? { text, page: page.index, line } : { text, page: page.index })
      previous = { y: line.y, size: line.size, page: page.index }
    }
  }
  flush()
  return paragraphs
}

/** Packs paragraphs into chunks of about `targetWords`, splitting long paragraphs at sentence ends. */
function packChunks(paragraphs: Paragraph[], options: ChunkOptions): ChunkDraft[] {
  const pieces: Word[][] = []
  for (const paragraph of paragraphs) pieces.push(...splitLong(paragraph.words, options.maxWords - options.overlapWords))

  const chunks: Word[][] = []
  let current: Word[] = []
  for (const piece of pieces) {
    if (current.length > 0 && current.length + piece.length > options.maxWords - options.overlapWords) {
      chunks.push(current)
      current = []
    }
    current.push(...piece)
    if (current.length >= options.targetWords) {
      chunks.push(current)
      current = []
    }
  }
  // A short tail joins the previous chunk when it fits; otherwise it stands alone.
  if (current.length > 0) {
    const last = chunks.at(-1)
    if (last && last.length + current.length <= options.maxWords) last.push(...current)
    else chunks.push(current)
  }

  return chunks.map((words, i) => {
    const overlap = i > 0 ? overlapFrom(chunks[i - 1] ?? [], options.overlapWords) : []
    const all = [...overlap, ...words]
    const transcribed = [...new Set(all.map((w) => w.line).filter((l): l is TextLine => l !== undefined))]
    const originals = transcribed.map((l) => l.original ?? '').filter((t) => t.trim() !== '')
    return {
      text: all.map((w) => w.text).join(' '),
      pageStart: Math.min(...all.map((w) => w.page)),
      pageEnd: Math.max(...all.map((w) => w.page)),
      originalText: transcribed.length > 0 ? originals.join('\n') : null
    }
  })
}

/** Splits a run of words into pieces of at most `max` words, preferring to cut after a sentence. */
function splitLong(words: Word[], max: number): Word[][] {
  const pieces: Word[][] = []
  let rest = words
  while (rest.length > max) {
    let cut = max
    for (let i = max; i > max / 2; i--) {
      if (/[.!?]["')\]]?$/.test(rest[i - 1]?.text ?? '')) {
        cut = i
        break
      }
    }
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) pieces.push(rest)
  return pieces
}

/** The last `count` words of a chunk, starting at a sentence boundary when one is close. */
function overlapFrom(words: Word[], count: number): Word[] {
  if (count <= 0) return []
  const tail = words.slice(-count)
  const sentenceStart = tail.findIndex((w, i) => i > 0 && /[.!?]$/.test(tail[i - 1]?.text ?? ''))
  return sentenceStart > 0 && sentenceStart < count / 2 ? tail.slice(sentenceStart) : tail
}

/**
 * The text of one section, page by page, without running heads and page numbers, for sending a
 * whole section to a model. Pages with no text in the section are left out.
 */
export function sectionPageTexts(
  pages: StoredPage[],
  start: SectionStart,
  next: SectionStart | null,
  bodySize: number | null,
  stripMargins: boolean
): { index: number; text: string }[] {
  const result: { index: number; text: string }[] = []
  for (const page of [...pages].sort((a, b) => a.index - b.index)) {
    const lines = (stripMargins ? contentLines(page, bodySize) : page.lines).filter((line) => inSection(page.index, line.y, start, next))
    const text = lines.map((line) => line.text).join('\n').trim()
    if (text !== '') result.push({ index: page.index, text })
  }
  return result
}
