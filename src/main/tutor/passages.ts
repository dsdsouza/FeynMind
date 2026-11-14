import { citationOf, citeValue, type SourceRef } from '../../shared/citations'
import type { SearchResponse } from '../../shared/ingestion'
import type { ChunkText, IngestionReader } from '../ingestion'
import { textTokens } from '../knowledge'

// The textbook passages the tutor is given for a concept. The chunks covering the pages the
// concept was extracted from come first (they define it), then the best hybrid-search results
// for its name and definition, until the token budget is used.

/** A passage with its tag (S1, S2, ...), as sent to the model. */
export interface Passage extends SourceRef {
  chunkId: number
  text: string
}

export interface RetrievalSource {
  reader: IngestionReader
  search(sessionId: number, query: string): Promise<SearchResponse>
}

export interface ConceptForRetrieval {
  name: string
  definition: string
  pages: { materialId: number; pageIndex: number }[]
}

/** Tokens of passage text for a lesson's questions, explanation and grading. */
export const LESSON_BUDGET = 2500
/** Tokens per concept in a diagnostic batch, which asks about several concepts at once. */
export const DIAGNOSTIC_BUDGET = 700
/** Search results considered after the concept's own pages. */
const SEARCH_RESULTS = 6
const MAX_QUERY = 900

export async function retrievePassages(source: RetrievalSource, sessionId: number, concept: ConceptForRetrieval, budget: number, firstTag = 1): Promise<Passage[]> {
  const own: number[] = []
  const byMaterial = new Map<number, number[]>()
  for (const p of concept.pages) byMaterial.set(p.materialId, [...(byMaterial.get(p.materialId) ?? []), p.pageIndex])
  for (const [materialId, pages] of byMaterial) own.push(...source.reader.chunksCoveringPages(materialId, pages))
  const query = `${concept.name}: ${concept.definition}`.slice(0, MAX_QUERY)
  const found = (await source.search(sessionId, query)).results.slice(0, SEARCH_RESULTS).map((r) => r.chunkId)
  const ids = [...new Set([...own, ...found])]

  const passages: Passage[] = []
  let used = 0
  for (const chunk of source.reader.chunks(ids)) {
    const tokens = textTokens(chunk.text)
    // The first passage is always kept, cut to the budget if it must be; later ones only if they fit.
    if (passages.length > 0 && used + tokens > budget) continue
    const text = passages.length === 0 && tokens > budget ? cutToTokens(chunk.text, budget) : chunk.text
    passages.push(toPassage(chunk, `S${firstTag + passages.length}`, text))
    used += textTokens(text)
    if (used >= budget) break
  }
  return passages
}

function toPassage(chunk: ChunkText, tag: string, text: string): Passage {
  return { tag, chunkId: chunk.chunkId, materialId: chunk.materialId, fileName: chunk.fileName, chapter: chunk.chapter, section: chunk.section, pages: chunk.pages, text }
}

/** The start of a text, at most about `budget` tokens, cut at a word boundary. */
function cutToTokens(text: string, budget: number): string {
  let end = text.length
  while (end > 0 && textTokens(text.slice(0, end)) > budget) end = text.lastIndexOf(' ', Math.floor(end * 0.9))
  return `${text.slice(0, Math.max(0, end)).trimEnd()} …`
}

/** Passages as the prompts show them: a header naming the passage and the citations it allows, then its text. */
export function formatPassages(passages: Passage[]): string {
  if (passages.length === 0) return '(No passages from the materials were found for this concept.)'
  return passages
    .map((p) => {
      const where = [p.fileName, p.chapter, p.section].filter(Boolean).join(', ')
      const cites = p.pages.map((page) => `[${citationOf(p.tag, page)}]`).join(' ')
      return `[${p.tag}] ${where}\nCite as: ${cites}\n${p.text}`
    })
    .join('\n\n')
}

/** What the interface needs to open the pages of these passages. */
export function sourceRefs(passages: Passage[]): SourceRef[] {
  return passages.map(({ tag, materialId, fileName, chapter, section, pages }) => ({ tag, materialId, fileName, chapter, section, pages }))
}

/** Every citation the passages allow, e.g. "S1 p. 12". */
export function allowedCitations(passages: SourceRef[]): Set<string> {
  return new Set(passages.flatMap((p) => p.pages.map((page) => `${p.tag} p. ${citeValue(page)}`)))
}
