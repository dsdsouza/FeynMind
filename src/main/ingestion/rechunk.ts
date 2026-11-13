import { chunkSection, DEFAULT_CHUNK_OPTIONS } from './chunker'
import type { IngestionRepo } from './repo'

/**
 * Rebuilds one section's chunks from its pages, using transcriptions where there are any. The new
 * chunks wait for vectors; run the ingestion runner to embed them. Returns the number of chunks.
 */
export function rechunkSection(repo: IngestionRepo, sectionId: number): number {
  const bounds = repo.sectionBounds(sectionId)
  if (!bounds) throw new Error(`Section ${sectionId} no longer exists.`)
  const lastPage = bounds.next?.startPage ?? bounds.material.pageCount ?? bounds.lastPage
  const pages = repo.loadPages(bounds.material.id, bounds.start.startPage, lastPage, true)
  const drafts = chunkSection(pages, bounds.start, bounds.next, bounds.material.bodyFontSize, {
    ...DEFAULT_CHUNK_OPTIONS,
    stripMargins: bounds.material.kind === 'pdf'
  })
  repo.replaceSectionChunks(sectionId, drafts)
  return drafts.length
}

/** Sections of a material whose pages include any of `pageIndexes`. */
export function sectionsTouching(repo: IngestionRepo, materialId: number, pageIndexes: number[]): number[] {
  return repo
    .sessionSections(repo.getMaterial(materialId)?.sessionId ?? -1)
    .filter((s) => s.materialId === materialId)
    .filter((s) => {
      const b = repo.sectionBounds(s.id)
      return b !== undefined && pageIndexes.some((p) => p >= b.start.startPage && p <= b.lastPage)
    })
    .map((s) => s.id)
}
