import type { PageRef } from '../../shared/ingestion'
import type { TocEntry } from '../../shared/knowledge'
import { sectionPageTexts } from './chunker'
import type { IngestionRepo, PageForVision } from './repo'

/** One section's text, page by page, with what a model needs to know about where it is. */
export interface SectionContent {
  sectionId: number
  materialId: number
  fileName: string
  materialSha: string
  chapter: string | null
  section: string | null
  pages: { index: number; label: string | null; text: string }[]
  /** Every page the section touches, including ones with no text. */
  pageRange: { from: number; to: number }
}

/** A whole chunk with the pages it spans, for grounding the tutor's answers. */
export interface ChunkText {
  chunkId: number
  materialId: number
  fileName: string
  chapter: string | null
  section: string | null
  pages: PageRef[]
  text: string
}

/**
 * Read-only access to imported material for other modules (the knowledge module). Runs on the
 * main process's own database connection; all writes to ingestion tables stay in the worker.
 */
export class IngestionReader {
  constructor(private readonly repo: IngestionRepo) {}

  /** The session's chapters and sections in book order. Sections split only for length are one entry. */
  tableOfContents(sessionId: number): TocEntry[] {
    const entries: TocEntry[] = []
    let last: TocEntry | null = null
    for (const row of this.repo.sessionSections(sessionId)) {
      const bounds = this.repo.sectionBounds(row.id)
      const material = bounds?.material
      if (!bounds || !material) continue
      const end = this.pageRef(material.id, bounds.lastPage)
      if (last && last.materialId === row.materialId && last.chapter === row.chapter && last.section === row.section) {
        last.sectionIds.push(row.id)
        last.pageEnd = end
        continue
      }
      last = {
        key: `${row.materialId}:${row.id}`,
        materialId: row.materialId,
        fileName: material.originalName,
        chapter: row.chapter,
        section: row.section,
        pageStart: this.pageRef(material.id, row.startPage),
        pageEnd: end,
        sectionIds: [row.id]
      }
      entries.push(last)
    }
    return entries
  }

  sectionContent(sectionId: number): SectionContent | undefined {
    const bounds = this.repo.sectionBounds(sectionId)
    if (!bounds) return undefined
    const { material, start, next, lastPage } = bounds
    const loadTo = next?.startPage ?? lastPage
    const pages = this.repo.loadPages(material.id, start.startPage, loadTo, true)
    const texts = sectionPageTexts(pages, start, next, material.bodyFontSize, material.kind === 'pdf')
    const labels = new Map(this.repo.pageTexts(material.id, start.startPage, loadTo).map((p) => [p.index, p.label]))
    return {
      sectionId,
      materialId: material.id,
      fileName: material.originalName,
      materialSha: material.sha256,
      chapter: start.chapter,
      section: start.section,
      pages: texts.map((t) => ({ index: t.index, label: labels.get(t.index) ?? null, text: t.text })),
      pageRange: { from: start.startPage, to: lastPage }
    }
  }

  /** Pages of these sections flagged as math-heavy or figure-heavy, in book order, without repeats. Slides are left out (they cannot be rendered). */
  flaggedPages(sectionIds: number[]): { materialId: number; pageIndex: number }[] {
    const seen = new Set<string>()
    const result: { materialId: number; pageIndex: number }[] = []
    for (const id of sectionIds) {
      const bounds = this.repo.sectionBounds(id)
      if (!bounds || bounds.material.kind !== 'pdf') continue
      for (const pageIndex of this.repo.flaggedPages(bounds.material.id, bounds.start.startPage, bounds.lastPage)) {
        const key = `${bounds.material.id}:${pageIndex}`
        if (seen.has(key)) continue
        seen.add(key)
        result.push({ materialId: bounds.material.id, pageIndex })
      }
    }
    return result.sort((a, b) => a.materialId - b.materialId || a.pageIndex - b.pageIndex)
  }

  /** Sections whose pages include this page. */
  sectionsOnPage(sectionIds: number[], materialId: number, pageIndex: number): number[] {
    return sectionIds.filter((id) => {
      const b = this.repo.sectionBounds(id)
      return b !== undefined && b.material.id === materialId && pageIndex >= b.start.startPage && pageIndex <= b.lastPage
    })
  }

  /** The material a section belongs to, or undefined if the section is gone. */
  materialOfSection(sectionId: number): number | undefined {
    return this.repo.getSection(sectionId)?.materialId
  }

  pageForVision(materialId: number, pageIndex: number): PageForVision | undefined {
    return this.repo.pageForVision(materialId, pageIndex)
  }

  hasTranscript(materialId: number, pageIndex: number): boolean {
    return this.repo.hasTranscript(materialId, pageIndex)
  }

  materialSha(materialId: number): string | undefined {
    return this.repo.getMaterial(materialId)?.sha256
  }

  fileName(materialId: number): string | undefined {
    return this.repo.getMaterial(materialId)?.originalName
  }

  /** Chunks that cover any of these pages of a material, in book order. */
  chunksCoveringPages(materialId: number, pageIndexes: number[]): number[] {
    return pageIndexes.length === 0 ? [] : this.repo.chunksCoveringPages(materialId, pageIndexes)
  }

  /** Whole chunks with every page they span (and its printed number), in the order asked for. Missing ids are left out. */
  chunks(ids: number[]): ChunkText[] {
    const details = this.repo.chunkDetails(ids)
    const result: ChunkText[] = []
    for (const id of ids) {
      const c = details.get(id)
      if (!c) continue
      result.push({
        chunkId: c.id,
        materialId: c.materialId,
        fileName: c.fileName,
        chapter: c.chapter,
        section: c.section,
        pages: this.repo.pageLabels(c.materialId, c.pageStart, c.pageEnd),
        text: c.text
      })
    }
    return result
  }

  pageRef(materialId: number, pageIndex: number): PageRef {
    return { index: pageIndex, label: this.repo.pageTexts(materialId, pageIndex, pageIndex)[0]?.label ?? null }
  }
}
