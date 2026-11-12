import { MATCH_END, MATCH_START, type SearchResponse, type SearchResult } from '../../shared/ingestion'
import type { Embedder } from './embedder'
import type { IngestionRepo } from './repo'

// Hybrid search: keyword matches (FTS5, BM25) and vector neighbours (sqlite-vec, cosine), merged
// with reciprocal rank fusion, which needs no tuning between the two very different scores.

const CANDIDATES = 50
/** The usual constant for reciprocal rank fusion; it damps the advantage of the very top ranks. */
const RRF_K = 60
export const DEFAULT_RESULTS = 8

const STOPWORDS = new Set(
  'a an and are as at be by can do does for from how i in is it of on or that the this to was what when where which who why with'.split(' ')
)

/** The query's words, lower-cased, without very common words. */
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return [...new Set(words.filter((w) => !STOPWORDS.has(w) && (w.length > 1 || /\d/.test(w))))]
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
  const keywordIds = fts ? repo.keywordSearch(sessionId, fts, CANDIDATES) : []
  const vectorIds = embedder && query.trim() !== '' ? repo.vectorSearch(sessionId, await embedder.embedQuery(query.trim()), CANDIDATES) : []

  const scores = new Map<number, number>()
  keywordIds.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)))
  vectorIds.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)))
  const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id)

  const keywordSet = new Set(keywordIds)
  const vectorSet = new Set(vectorIds)
  const details = repo.chunkDetails(top)
  const results: SearchResult[] = []
  for (const id of top) {
    const chunk = details.get(id)
    if (!chunk) continue
    results.push({
      chunkId: id,
      materialId: chunk.materialId,
      fileName: chunk.fileName,
      chapter: chunk.chapter,
      section: chunk.section,
      pageStart: { index: chunk.pageStart, label: chunk.labelStart },
      pageEnd: { index: chunk.pageEnd, label: chunk.labelEnd },
      snippet: highlight(chunk.text, terms),
      matchedBy: { keyword: keywordSet.has(id), vector: vectorSet.has(id) }
    })
  }
  return { results, mode: embedder ? 'hybrid' : 'keyword' }
}

/** Marks words that start with a query term (so "matrices" matches "matrix" loosely enough to show). */
export function highlight(text: string, terms: string[]): string {
  const stems = terms.filter((t) => t.length >= 3).map((t) => (t.length > 5 ? t.slice(0, t.length - 2) : t))
  if (stems.length === 0) return text
  const escaped = stems.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})[\\p{L}\\p{N}]*`, 'giu')
  return text.replace(pattern, (word) => `${MATCH_START}${word}${MATCH_END}`)
}
