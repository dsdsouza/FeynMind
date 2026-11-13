// Exact-wording matching for search: finds where a passage repeats the query's words in order, and
// which sentences of a passage to open a result on. Plain text work, no database and no model.

/** Very common words. They are left out of keyword queries and do not count towards a wording match. */
export const STOPWORDS = new Set(
  (
    'a an and are as at be by can do does for from has have how i in is it its of on or that the this to was what when ' +
    'where which who why with you your'
  ).split(' ')
)

/** Number words up to twelve, so "three by four" matches "3 by 4" (and the reverse). */
export const NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12'
}

export interface WordToken {
  /** Lower-cased, number words as digits, a trailing plural "s" removed. */
  word: string
  start: number
  end: number
}

/** Lower-cases a word, writes number words as digits and drops a plural "s" ("transforms" → "transform"). */
export function normalizeWord(raw: string): string {
  const word = raw.toLowerCase()
  const number = NUMBER_WORDS[word]
  if (number !== undefined) return number
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word
}

/** The words of a text with their positions. Punctuation and brackets are skipped, so "(1,1)" is "1", "1". */
export function wordTokens(text: string): WordToken[] {
  const tokens: WordToken[] = []
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) tokens.push({ word: normalizeWord(m[0]), start: m.index, end: m.index + m[0].length })
  return tokens
}

/** Words that carry meaning: not a stopword, and not a single letter (single digits count). */
export function isContentWord(word: string): boolean {
  return !STOPWORDS.has(word) && (word.length > 1 || /\d/.test(word))
}

export interface Run {
  /** Where the run starts in the first and second sequence. */
  aStart: number
  bStart: number
  length: number
}

/** The longest stretch of words that appears consecutively, in the same order, in both sequences. */
export function longestRun(a: readonly string[], b: readonly string[]): Run {
  let best: Run = { aStart: 0, bStart: 0, length: 0 }
  let previous = new Uint16Array(a.length + 1)
  let current = new Uint16Array(a.length + 1)
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const length = a[i - 1] === b[j - 1] ? (previous[i - 1] ?? 0) + 1 : 0
      current[i] = length
      if (length > best.length) best = { aStart: i - length, bStart: j - length, length }
    }
    ;[previous, current] = [current, previous]
  }
  return best
}

/** A wording match needs at least this many meaningful query words, in a row... */
export const MIN_MATCHED_WORDS = 3
/** ...covering at least this share of the query's meaningful words. */
export const MIN_COVERAGE = 0.5

export interface WordingMatch {
  /** Character range of the matched words in the passage. */
  start: number
  end: number
  /** Share of the query's meaningful words that the run covers (0 to 1). */
  coverage: number
}

/**
 * Where the passage repeats the query's wording: the longest run of query words found consecutively
 * and in order. Null unless the run holds at least MIN_MATCHED_WORDS meaningful words and
 * MIN_COVERAGE of the query's meaningful words.
 */
export function wordingMatch(queryWords: readonly WordToken[], passage: string): WordingMatch | null {
  const total = queryWords.filter((t) => isContentWord(t.word)).length
  if (total < MIN_MATCHED_WORDS) return null
  const words = wordTokens(passage)
  const run = longestRun(
    queryWords.map((t) => t.word),
    words.map((t) => t.word)
  )
  const matched = queryWords.slice(run.aStart, run.aStart + run.length).filter((t) => isContentWord(t.word)).length
  const coverage = matched / total
  const first = words[run.bStart]
  const last = words[run.bStart + run.length - 1]
  if (matched < MIN_MATCHED_WORDS || coverage < MIN_COVERAGE || !first || !last) return null
  return { start: first.start, end: last.end, coverage }
}

export interface Span {
  start: number
  end: number
}

/** Sentence spans of a text. A sentence ends at ".", "?" or "!" followed by white space. */
export function sentences(text: string): Span[] {
  const spans: Span[] = []
  let start = 0
  for (const m of text.matchAll(/[.?!]["')\]]*\s+/g)) {
    const end = m.index + m[0].trimEnd().length
    if (text.slice(start, end).trim() !== '') spans.push({ start, end })
    start = m.index + m[0].length
  }
  if (text.slice(start).trim() !== '') spans.push({ start, end: text.trimEnd().length })
  return spans
}

/** Context kept around a match when its sentence is very long (garbled math often has no full stops). */
const MAX_BEFORE = 200
const MAX_AFTER = 300

/** The sentences containing the character range, trimmed at word boundaries if they are very long. */
export function sentencesAround(text: string, range: Span): Span {
  const spans = sentences(text)
  let start = spans.findLast((s) => s.start <= range.start)?.start ?? 0
  let end = spans.find((s) => s.end >= range.end)?.end ?? text.length
  if (range.start - start > MAX_BEFORE) start = wordBoundaryAfter(text, range.start - MAX_BEFORE)
  if (end - range.end > MAX_AFTER) end = wordBoundaryBefore(text, range.end + MAX_AFTER)
  return { start, end }
}

function wordBoundaryAfter(text: string, at: number): number {
  const space = text.indexOf(' ', at)
  return space === -1 || space > text.length ? at : space + 1
}

function wordBoundaryBefore(text: string, at: number): number {
  const space = text.lastIndexOf(' ', at)
  return space <= 0 ? at : space
}

/**
 * The sentence holding the most different query words (the earliest one on a tie), as a range to
 * open a result on. Null when no sentence contains any of them.
 */
export function bestSentence(text: string, matchesTerm: (word: string) => string | null): Span | null {
  let best: Span | null = null
  let bestCount = 0
  for (const span of sentences(text)) {
    const found = new Set<string>()
    for (const m of text.slice(span.start, span.end).matchAll(/[\p{L}\p{N}]+/gu)) {
      const term = matchesTerm(m[0])
      if (term !== null) found.add(term)
    }
    if (found.size > bestCount) {
      best = span
      bestCount = found.size
    }
  }
  return best && sentencesAround(text, { start: best.start, end: Math.min(best.end, best.start + MAX_AFTER) })
}

export interface PageText {
  index: number
  label: string | null
  text: string
}

/**
 * The pages holding the given words, found by lining them up with the stored text of the passage's
 * pages. Running heads and page numbers can break the words up, so the longest stretch found wins;
 * it needs at least three words (or all of them, if fewer). Null when they cannot be placed.
 */
export function locateOnPages(words: readonly string[], pages: readonly PageText[]): { start: PageText; end: PageText } | null {
  const stream: string[] = []
  const pageOf: PageText[] = []
  for (const page of pages) {
    for (const t of wordTokens(page.text)) {
      stream.push(t.word)
      pageOf.push(page)
    }
  }
  const run = longestRun(words, stream)
  const start = pageOf[run.bStart]
  const end = pageOf[run.bStart + run.length - 1]
  if (run.length < Math.min(3, words.length) || run.length === 0 || !start || !end) return null
  return { start, end }
}
