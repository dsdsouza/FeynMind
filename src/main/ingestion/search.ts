import { MATCH_END, MATCH_START, type PageRef, type SearchResponse, type SearchResult } from '../../shared/ingestion'
import type { Embedder } from './embedder'
import type { ChunkDetails, IngestionRepo } from './repo'
import {
  bestSentence,
  locateOnPages,
  NUMBER_WORDS,
  sentencesAround,
  STOPWORDS,
  wordingMatch,
  wordTokens,
  type Span,
  type WordingMatch,
  type WordToken
} from './wording'

// Hybrid search: keyword matches (FTS5, BM25) and vector neighbours (sqlite-vec, cosine), merged
// with reciprocal rank fusion, which needs no tuning between the two very different scores.
// Passages that repeat the query's own wording (an exercise quoted from the book, say) go first.

const CANDIDATES = 50
/** Keyword matches checked for the query's exact wording. More than CANDIDATES: BM25 ranks such a passage low when the query's words are common. */
const WORDING_CANDIDATES = 200
/** The usual constant for reciprocal rank fusion; it damps the advantage of the very top ranks. */
const RRF_K = 60
export const DEFAULT_RESULTS = 8
/** Limits on placing the focus sentences on a page: words compared, and pages searched. */
const MAX_PROBE_WORDS = 40
const MAX_LOCATE_PAGES = 10

const DIGIT_WORDS = new Map(Object.entries(NUMBER_WORDS).map(([word, digit]) => [digit, word]))

/** The query's words, lower-cased, without very common words. Numbers get both spellings ("three" and "3"). */
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const terms = words.filter((w) => !STOPWORDS.has(w) && (w.length > 1 || /\d/.test(w)))
  const other = terms.map((t) => NUMBER_WORDS[t] ?? DIGIT_WORDS.get(t)).filter((t) => t !== undefined)
  return [...new Set([...terms, ...other])]
}

/** An FTS5 query matching any of the terms. Every term is quoted, so user input is never parsed as FTS syntax. */
export function ftsQuery(terms: string[]): string | null {
  return terms.length === 0 ? null : terms.map((t) => `"${t.replaceAll('"', '')}"`).join(' OR ')
}

export async function searchPassages(
  repo: IngestionRepo,
  sessionId: number,
  query: string,
  embedder: Embedder | null,
  limit = DEFAULT_RESULTS
): Promise<SearchResponse> {
  const terms = queryTerms(query)
  const fts = ftsQuery(terms)
  const keywordIds = fts ? repo.keywordSearch(sessionId, fts, WORDING_CANDIDATES) : []
  const vectorIds = embedder && query.trim() !== '' ? repo.vectorSearch(sessionId, await embedder.embedQuery(query.trim()), CANDIDATES) : []

  const scores = new Map<number, number>()
  keywordIds.slice(0, CANDIDATES).forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)))
  vectorIds.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)))

  // Passages repeating the query's wording come first, closest first; the rest keep the fused order.
  const queryWords = wordTokens(query)
  const wording = new Map<number, WordingMatch>()
  for (const [id, text] of repo.chunkTexts([...new Set([...keywordIds, ...vectorIds])])) {
    const match = wordingMatch(queryWords, text)
    if (match) wording.set(id, match)
  }
  const fused = (id: number): number => scores.get(id) ?? 0
  const top = [
    ...[...wording.keys()].sort((a, b) => (wording.get(b)?.coverage ?? 0) - (wording.get(a)?.coverage ?? 0) || fused(b) - fused(a)),
    ...[...scores.keys()].filter((id) => !wording.has(id)).sort((a, b) => fused(b) - fused(a))
  ].slice(0, limit)

  const keywordSet = new Set(keywordIds)
  const vectorSet = new Set(vectorIds)
  const details = repo.chunkDetails(top)
  const results: SearchResult[] = []
  for (const id of top) {
    const chunk = details.get(id)
    if (!chunk) continue
    const opened = openOn(chunk.text, terms, wording.get(id) ?? null)
    const pageStart = { index: chunk.pageStart, label: chunk.labelStart }
    const pageEnd = { index: chunk.pageEnd, label: chunk.labelEnd }
    const match = opened.kind === 'none' ? null : matchPages(repo, chunk, opened.probe)
    results.push({
      chunkId: id,
      materialId: chunk.materialId,
      fileName: chunk.fileName,
      chapter: chunk.chapter,
      section: chunk.section,
      pageStart,
      pageEnd,
      matchStart: match?.start ?? pageStart,
      matchEnd: match?.end ?? pageEnd,
      context: opened.context,
      focusKind: opened.kind,
      matchedBy: { keyword: keywordSet.has(id), vector: vectorSet.has(id), wording: wording.has(id) }
    })
  }
  return { results, mode: embedder ? 'hybrid' : 'keyword' }
}

interface Opened {
  context: SearchResult['context']
  kind: SearchResult['focusKind']
  /** The words to find on the page: the matched wording, or the focus sentences. */
  probe: string[]
}

/** Splits a passage around the sentences to open on, with matches marked. */
export function openOn(text: string, terms: string[], wording: WordingMatch | null): Opened {
  const stems = termStems(terms)
  const matchesTerm = (word: string): string | null => stems.find((s) => word.toLowerCase().startsWith(s)) ?? null
  let focus: Span
  let kind: Opened['kind']
  if (wording) {
    focus = sentencesAround(text, wording)
    kind = 'wording'
  } else {
    const best = bestSentence(text, matchesTerm)
    focus = best ?? sentencesAround(text, { start: 0, end: 0 })
    kind = best ? 'words' : 'none'
  }
  const mark = (part: string): string => highlight(part, terms)
  const focusText = wording
    ? mark(text.slice(focus.start, wording.start)) +
      `${MATCH_START}${text.slice(wording.start, wording.end)}${MATCH_END}` +
      mark(text.slice(wording.end, focus.end))
    : mark(text.slice(focus.start, focus.end))
  const probeRange = wording ?? focus
  return {
    context: { before: mark(text.slice(0, focus.start).trimEnd()), focus: focusText.trim(), after: mark(text.slice(focus.end).trimStart()) },
    kind,
    probe: wordTokens(text.slice(probeRange.start, probeRange.end))
      .slice(0, MAX_PROBE_WORDS)
      .map((t: WordToken) => t.word)
  }
}

/** The pages the probe words are on, or null if they cannot be placed. */
function matchPages(repo: IngestionRepo, chunk: ChunkDetails, probe: string[]): { start: PageRef; end: PageRef } | null {
  if (chunk.pageStart === chunk.pageEnd) return null
  const pages = repo.pageTexts(chunk.materialId, chunk.pageStart, Math.min(chunk.pageEnd, chunk.pageStart + MAX_LOCATE_PAGES - 1))
  const found = locateOnPages(probe, pages)
  return found && { start: { index: found.start.index, label: found.start.label }, end: { index: found.end.index, label: found.end.label } }
}

/** Word beginnings to highlight: the terms, with longer ones cut short so "matrices" also marks "matrix". */
function termStems(terms: string[]): string[] {
  return terms.filter((t) => t.length >= 3).map((t) => (t.length > 5 ? t.slice(0, t.length - 2) : t))
}

/** Marks words that start with a query term (so "matrices" matches "matrix" loosely enough to show). */
export function highlight(text: string, terms: string[]): string {
  const stems = termStems(terms)
  if (stems.length === 0) return text
  const escaped = stems.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})[\\p{L}\\p{N}]*`, 'giu')
  return text.replace(pattern, (word) => `${MATCH_START}${word}${MATCH_END}`)
}
