import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { chunkSection, DEFAULT_CHUNK_OPTIONS } from './chunker'
import type { Embedder } from './embedder'
import type { OcrEngine } from './ocr'
import { analyzePage } from './pageAnalysis'
import type { IngestionRepo, MaterialRow, Structure } from './repo'
import {
  findHeadings,
  headingStyleOf,
  inferPageLabels,
  isUsableOutline,
  sectionsFromOutline,
  splitLongSections,
  type HeadingStyle,
  withLeadingStart,
  type SectionStart
} from './structure'
import type { DocumentSource, PageContent, TextLine } from './types'

// The ingestion queue. All its state lives in the database, so it can stop at any point (including
// a crash) and continue later without redoing finished work:
//   - each page is committed on its own once read;
//   - a section and its chunks are committed together once all its pages are read;
//   - each chunk is marked once its vector is stored.
// Files are processed one at a time in the order they were added, and each section becomes
// searchable as soon as it is chunked (keyword search) and embedded (vector search).

/** Pages without text are rendered at this resolution for text recognition. */
export const OCR_DPI = 200
/** Pages sampled to decide the body font size and heading style of a document without an outline. */
const HEADING_SAMPLE_PAGES = 30
/** Long stretches without a heading are cut here so they become searchable sooner. */
const SPLIT_EVERY_PAGES = 20
const EMBED_BATCH = 32
/** How far back printed page numbers are re-inferred after each section. */
const LABEL_WINDOW = 40

export interface RunnerDeps {
  repo: IngestionRepo
  materialsDir: string
  openDocument: (kind: MaterialRow['kind'], path: string) => Promise<DocumentSource>
  ocr: OcrEngine
  /** The embedder, or null while the model is not available (keyword search still works). */
  embedder: () => Embedder | null
  /** Called whenever a material's progress changes. */
  onProgress: (materialId: number) => void
  /** Called when embedding fails; the runner stops embedding until it is run again. */
  onEmbedError?: (error: unknown) => void
  now?: () => number
}

export class IngestionRunner {
  private running: Promise<void> | null = null
  private runAgain = false
  private stopped = false
  private readonly now: () => number

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? (() => performance.now())
  }

  /** Processes everything that is waiting. Calling it while it runs makes it check again when done. */
  run(): Promise<void> {
    if (this.running) {
      this.runAgain = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.runAgain = false
        await this.drain()
      } while (this.runAgain && !this.stopped)
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** Stops after the current page. Everything finished so far is kept. */
  async stop(): Promise<void> {
    this.stopped = true
    await this.running
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const material = this.deps.repo.nextMaterialToRead()
      if (!material) break
      await this.readMaterial(material)
    }
    if (!this.stopped) await this.embedPending()
    for (const id of this.deps.repo.completeMaterials()) this.deps.onProgress(id)
  }

  private async readMaterial(material: MaterialRow): Promise<void> {
    const { repo } = this.deps
    const path = join(this.deps.materialsDir, material.storedName)
    let source: DocumentSource
    try {
      if (!existsSync(path)) throw new Error('The copy of this file in the app’s data folder is missing. Add the file again.')
      source = await this.deps.openDocument(material.kind, path)
    } catch (error) {
      repo.failMaterial(material.id, messageOf(error))
      this.deps.onProgress(material.id)
      return
    }

    try {
      const outline = await source.outline()
      const structure: Structure = material.kind === 'pptx' ? 'slides' : isUsableOutline(outline) ? 'outline' : 'headings'
      repo.startMaterial(material.id, source.pageCount, structure)
      this.deps.onProgress(material.id)
      const labels = await source.pageLabels()
      const plan = new SectionPlan(material, structure, source.pageCount, outline)

      const done = repo.processedPageIndexes(material.id)
      for (let page = 1; page <= source.pageCount; page++) {
        if (this.stopped) return
        if (done.has(page)) continue
        await this.readPage(material, source, page, labels?.[page - 1] ?? null)
        done.add(page)
        this.deps.onProgress(material.id)
        // Pages are read in order, so every page up to this one is now read.
        if (await this.completeSections(material, plan, page, labels === null)) await this.embedPending()
      }
      if (this.stopped) return
      await this.completeSections(material, plan, source.pageCount, labels === null)
      if (labels === null && material.kind === 'pdf') repo.updatePageLabels(material.id, inferPageLabels(repo.loadPages(material.id, 1, source.pageCount)))
      repo.finishReading(material.id)
      this.deps.onProgress(material.id)
      await this.embedPending()
    } catch (error) {
      repo.failMaterial(material.id, messageOf(error))
      this.deps.onProgress(material.id)
    } finally {
      await source.close()
      // Text recognition holds a large WASM heap; release it between files (it restarts when needed).
      await this.deps.ocr.close()
    }
  }

  private async readPage(material: MaterialRow, source: DocumentSource, pageIndex: number, label: string | null): Promise<void> {
    const started = this.now()
    let ocrMs = 0
    try {
      const content = await source.readPage(pageIndex)
      let flags = analyzePage(content)
      let lines = content.lines
      let method: 'text' | 'ocr' | 'slide' | 'empty' = material.kind === 'pptx' ? 'slide' : 'text'
      let confidence: number | null = null
      if (flags.scanned) {
        const ocrStarted = this.now()
        const png = await source.renderPage(pageIndex, OCR_DPI)
        if (png) {
          const result = await this.deps.ocr.recognize(png, OCR_DPI / 72)
          lines = result.lines
          confidence = result.confidence
          method = 'ocr'
          flags = { ...analyzePage(recognizedContent(content, lines)), scanned: true }
        } else {
          // A slide that is only a picture: nothing to read, but worth showing to a vision model later.
          flags = { scanned: false, mathHeavy: false, figureHeavy: true }
        }
        ocrMs = this.now() - ocrStarted
      }
      if (lines.length === 0) method = 'empty'
      this.deps.repo.insertPage({
        sessionId: material.sessionId,
        materialId: material.id,
        pageIndex,
        pageLabel: label,
        status: 'done',
        method,
        lines,
        height: content.height,
        scanned: flags.scanned,
        mathHeavy: flags.mathHeavy,
        figureHeavy: flags.figureHeavy,
        ocrConfidence: confidence,
        error: null
      })
    } catch (error) {
      this.deps.repo.insertPage({
        sessionId: material.sessionId,
        materialId: material.id,
        pageIndex,
        pageLabel: label,
        status: 'failed',
        method: null,
        lines: [],
        height: 0,
        scanned: false,
        mathHeavy: false,
        figureHeavy: false,
        ocrConfidence: null,
        error: messageOf(error)
      })
    }
    this.deps.repo.addTimings(material.id, { extractMs: this.now() - started - ocrMs, ocrMs })
  }

  /**
   * Chunks every section whose pages have all been read (pages 1..readUpTo). Returns true if any
   * section was added.
   */
  private async completeSections(material: MaterialRow, plan: SectionPlan, readUpTo: number, inferLabels: boolean): Promise<boolean> {
    const { repo } = this.deps
    const starts = plan.starts(repo, readUpTo)
    if (starts === null) return false
    const finished = readUpTo >= plan.pageCount
    let stored = repo.sectionCount(material.id)
    let added = false
    while (stored < starts.length) {
      const start = starts[stored]
      const next = starts[stored + 1] ?? null
      if (!start) break
      // A section is complete once the page where the next one starts has been read.
      if (next ? next.startPage > readUpTo : !finished) break
      const lastPage = next ? next.startPage : plan.pageCount
      const pages = repo.loadPages(material.id, start.startPage, lastPage)
      const chunks = chunkSection(pages, start, next, plan.bodySize(), { ...DEFAULT_CHUNK_OPTIONS, stripMargins: material.kind === 'pdf' })
      repo.insertSectionWithChunks({ sessionId: material.sessionId, materialId: material.id }, stored, start, plan.sourceOf(), chunks)
      stored++
      added = true
    }
    if (added && inferLabels && material.kind === 'pdf') {
      const from = Math.max(1, readUpTo - LABEL_WINDOW)
      repo.updatePageLabels(material.id, inferPageLabels(repo.loadPages(material.id, from, readUpTo)))
    }
    if (added) this.deps.onProgress(material.id)
    return added
  }

  /** Embeds every chunk still waiting for a vector, in file order. */
  private async embedPending(): Promise<void> {
    const { repo } = this.deps
    for (;;) {
      if (this.stopped) return
      const embedder = this.deps.embedder()
      if (!embedder) return
      const batch = repo.chunksToEmbed(EMBED_BATCH)
      if (batch.length === 0) return
      const started = this.now()
      let vectors: Float32Array[]
      try {
        vectors = await embedder.embedPassages(batch.map(embeddingText))
      } catch (error) {
        this.deps.onEmbedError?.(error)
        return
      }
      repo.storeVectors(batch.map((chunk, i) => ({ chunkId: chunk.id, sessionId: chunk.sessionId, vector: vectors[i] ?? new Float32Array() })))
      // Charge the time to the material of the first chunk; batches rarely span two files.
      const first = batch[0]
      if (first) repo.addTimings(first.materialId, { embedMs: this.now() - started })
      for (const id of new Set(batch.map((c) => c.materialId))) this.deps.onProgress(id)
    }
  }
}

/** The text that is embedded: the chunk with its chapter and section names, which help retrieval. */
export function embeddingText(chunk: { chapter: string | null; section: string | null; text: string }): string {
  const heading = [chunk.chapter, chunk.section].filter((part): part is string => !!part).join(' › ')
  return heading ? `${heading}\n${chunk.text}` : chunk.text
}

/** Decides where a material's sections start, from its outline or, failing that, its headings. */
class SectionPlan {
  private outlineStarts: SectionStart[] | null = null
  private style: HeadingStyle | null = null
  /** Headings found so far, and the last page scanned for them (each page is scanned once). */
  private headings: SectionStart[] = []
  private scannedUpTo = 0

  constructor(
    private readonly material: MaterialRow,
    private readonly structure: Structure,
    readonly pageCount: number,
    outline: Parameters<typeof sectionsFromOutline>[0]
  ) {
    if (structure !== 'headings') {
      this.outlineStarts = splitLongSections(sectionsFromOutline(outline), pageCount, SPLIT_EVERY_PAGES)
    } else if (material.numberedHeadings !== null && material.bodyFontSize !== null) {
      this.style = { bodySize: material.bodyFontSize, numbered: material.numberedHeadings === 1 }
    }
  }

  sourceOf(): 'outline' | 'headings' | 'slides' | 'whole' {
    if (this.structure !== 'headings') return this.structure
    return this.style ? 'headings' : 'whole'
  }

  bodySize(): number | null {
    return this.style?.bodySize ?? this.material.bodyFontSize
  }

  /** Section starts known once pages 1..readUpTo are read, or null if it is too early to tell. */
  starts(repo: IngestionRepo, readUpTo: number): SectionStart[] | null {
    if (this.outlineStarts) return this.outlineStarts
    if (!this.style && this.material.numberedHeadings === null) {
      // The heading style is fixed from the first pages, so later pages never change earlier sections.
      const sampleEnd = Math.min(HEADING_SAMPLE_PAGES, this.pageCount)
      if (readUpTo < sampleEnd) return null
      this.style = headingStyleOf(repo.loadPages(this.material.id, 1, sampleEnd))
      repo.setHeadingStyle(this.material.id, this.style?.bodySize ?? null, this.style?.numbered ?? false)
      this.material.numberedHeadings = this.style?.numbered ? 1 : 0
      this.material.bodyFontSize = this.style?.bodySize ?? null
    }
    if (this.style && readUpTo > this.scannedUpTo) {
      const pages = repo.loadPages(this.material.id, this.scannedUpTo + 1, readUpTo)
      this.headings.push(...findHeadings(pages, this.style, this.headings.at(-1)?.chapter ?? null))
      this.scannedUpTo = readUpTo
    }
    return splitLongSections(withLeadingStart(this.headings), this.pageCount, SPLIT_EVERY_PAGES)
  }
}

/** Page measurements for recognized text, so recognized pages can still be flagged. */
function recognizedContent(content: PageContent, lines: TextLine[]): PageContent {
  const text = lines.map((l) => l.text).join(' ')
  return {
    ...content,
    lines,
    stats: {
      charCount: text.replace(/\s/g, '').length,
      imageCoverage: 0,
      pathOps: 0,
      mathFontChars: 0,
      mathSymbolChars: text.match(/[Α-ω∀-⋿=+<>^−]/gu)?.length ?? 0,
      mathLayoutLines: 0,
      lineCount: lines.length
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
