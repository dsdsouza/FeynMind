import type Database from 'better-sqlite3'
import type { MaterialKind, MaterialStage, MaterialStatus, MaterialSummary, PageIssue } from '../../shared/ingestion'
import type { ChunkDraft } from './chunker'
import type { SectionStart, StoredPage } from './structure'
import { transcribedLines, type TranscriptBlock } from './transcripts'
import type { TextLine } from './types'
import type { PageText } from './wording'

// All SQL for the ingestion tables. Used by the worker (reads and writes) and by the main
// process (reads only).

export type Structure = 'outline' | 'headings' | 'slides'

export interface MaterialRow {
  id: number
  sessionId: number
  sha256: string
  originalName: string
  storedName: string
  kind: MaterialKind
  pageCount: number | null
  structure: Structure | null
  bodyFontSize: number | null
  numberedHeadings: number | null
  status: MaterialStatus
}

export interface NewPage {
  sessionId: number
  materialId: number
  pageIndex: number
  pageLabel: string | null
  status: 'done' | 'failed'
  method: 'text' | 'ocr' | 'slide' | 'empty' | null
  lines: TextLine[]
  height: number
  scanned: boolean
  mathHeavy: boolean
  figureHeavy: boolean
  ocrConfidence: number | null
  error: string | null
}

export interface ChunkToEmbed {
  id: number
  sessionId: number
  materialId: number
  chapter: string | null
  section: string | null
  text: string
}

export interface ChunkDetails {
  id: number
  materialId: number
  fileName: string
  kind: MaterialKind
  chapter: string | null
  section: string | null
  pageStart: number
  pageEnd: number
  labelStart: string | null
  labelEnd: string | null
  text: string
}

export interface SectionRow {
  id: number
  sessionId: number
  materialId: number
  ordinal: number
  chapter: string | null
  section: string | null
  startPage: number
  startY: number
}

/** A section with what is needed to cut its text out of its pages. */
export interface SectionBounds {
  section: SectionRow
  material: MaterialRow
  start: SectionStart
  next: SectionStart | null
  /** The last page the section touches. */
  lastPage: number
}

export interface PageForVision {
  materialId: number
  pageIndex: number
  label: string | null
  lines: TextLine[]
  mathHeavy: boolean
  figureHeavy: boolean
}

const SECTION_COLUMNS = `id, session_id AS sessionId, material_id AS materialId, ordinal, chapter, section,
  start_page AS startPage, start_y AS startY`

const MATERIAL_COLUMNS = `id, session_id AS sessionId, sha256, original_name AS originalName, stored_name AS storedName,
  kind, page_count AS pageCount, structure, body_font_size AS bodyFontSize,
  numbered_headings AS numberedHeadings, status`

export class IngestionRepo {
  constructor(readonly db: Database.Database) {}

  // Materials

  insertMaterial(m: { sessionId: number; sha256: string; originalName: string; storedName: string; kind: MaterialKind; byteSize: number }): number {
    const result = this.db
      .prepare('INSERT INTO materials (session_id, sha256, original_name, stored_name, kind, byte_size) VALUES (?, ?, ?, ?, ?, ?)')
      .run(m.sessionId, m.sha256, m.originalName, m.storedName, m.kind, m.byteSize)
    return Number(result.lastInsertRowid)
  }

  findMaterialBySha(sessionId: number, sha256: string): MaterialRow | undefined {
    return this.db.prepare<[number, string], MaterialRow>(`SELECT ${MATERIAL_COLUMNS} FROM materials WHERE session_id = ? AND sha256 = ?`).get(sessionId, sha256)
  }

  getMaterial(id: number): MaterialRow | undefined {
    return this.db.prepare<[number], MaterialRow>(`SELECT ${MATERIAL_COLUMNS} FROM materials WHERE id = ?`).get(id)
  }

  /** The first material, in the order added, whose pages are not all read yet. */
  nextMaterialToRead(): MaterialRow | undefined {
    return this.db
      .prepare<[], MaterialRow>(`SELECT ${MATERIAL_COLUMNS} FROM materials WHERE status != 'failed' AND read_at IS NULL ORDER BY id LIMIT 1`)
      .get()
  }

  startMaterial(id: number, pageCount: number, structure: Structure): void {
    this.db
      .prepare(
        `UPDATE materials SET page_count = ?, structure = ?, status = 'processing',
           started_at = coalesce(started_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = ?`
      )
      .run(pageCount, structure, id)
  }

  setHeadingStyle(id: number, bodyFontSize: number | null, numbered: boolean): void {
    this.db.prepare('UPDATE materials SET body_font_size = ?, numbered_headings = ? WHERE id = ?').run(bodyFontSize, numbered ? 1 : 0, id)
  }

  finishReading(id: number): void {
    this.db.prepare("UPDATE materials SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id)
  }

  failMaterial(id: number, error: string): void {
    this.db
      .prepare("UPDATE materials SET status = 'failed', error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(error, id)
  }

  addTimings(id: number, t: { extractMs?: number; ocrMs?: number; embedMs?: number }): void {
    this.db
      .prepare('UPDATE materials SET extract_ms = extract_ms + ?, ocr_ms = ocr_ms + ?, embed_ms = embed_ms + ? WHERE id = ?')
      .run(Math.round(t.extractMs ?? 0), Math.round(t.ocrMs ?? 0), Math.round(t.embedMs ?? 0), id)
  }

  /** Marks materials done once every page is read and every chunk embedded. Returns their ids. */
  completeMaterials(): number[] {
    const ready = this.db
      .prepare<[], { id: number }>(
        `SELECT id FROM materials m WHERE status = 'processing' AND read_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.material_id = m.id AND c.embedded = 0)`
      )
      .all()
      .map((r) => r.id)
    const mark = this.db.prepare("UPDATE materials SET status = 'done', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    for (const id of ready) mark.run(id)
    return ready
  }

  listMaterials(sessionId: number, modelReady: boolean): MaterialSummary[] {
    const ids = this.db.prepare<[number], { id: number }>('SELECT id FROM materials WHERE session_id = ? ORDER BY id').all(sessionId)
    return ids.map((r) => this.summary(r.id, modelReady)).filter((s): s is MaterialSummary => s !== null)
  }

  summary(id: number, modelReady: boolean): MaterialSummary | null {
    const row = this.db
      .prepare<
        [number],
        {
          id: number
          sessionId: number
          name: string
          kind: MaterialKind
          byteSize: number
          status: MaterialStatus
          error: string | null
          pageCount: number | null
          readAt: string | null
          extractMs: number
          ocrMs: number
          embedMs: number
          addedAt: string
          startedAt: string | null
          finishedAt: string | null
          pagesDone: number
          pagesFailed: number
          pagesOcr: number
          pagesMathHeavy: number
          pagesFigureHeavy: number
          chunkCount: number
          chunksEmbedded: number
        }
      >(
        `SELECT m.id, m.session_id AS sessionId, m.original_name AS name, m.kind, m.byte_size AS byteSize,
           m.status, m.error, m.page_count AS pageCount, m.read_at AS readAt,
           m.extract_ms AS extractMs, m.ocr_ms AS ocrMs, m.embed_ms AS embedMs,
           m.added_at AS addedAt, m.started_at AS startedAt, m.finished_at AS finishedAt,
           (SELECT count(*) FROM pages p WHERE p.material_id = m.id) AS pagesDone,
           (SELECT count(*) FROM pages p WHERE p.material_id = m.id AND p.status = 'failed') AS pagesFailed,
           (SELECT count(*) FROM pages p WHERE p.material_id = m.id AND p.method = 'ocr') AS pagesOcr,
           (SELECT count(*) FROM pages p WHERE p.material_id = m.id AND p.math_heavy = 1) AS pagesMathHeavy,
           (SELECT count(*) FROM pages p WHERE p.material_id = m.id AND p.figure_heavy = 1) AS pagesFigureHeavy,
           (SELECT count(*) FROM chunks c WHERE c.material_id = m.id) AS chunkCount,
           (SELECT count(*) FROM chunks c WHERE c.material_id = m.id AND c.embedded = 1) AS chunksEmbedded
         FROM materials m WHERE m.id = ?`
      )
      .get(id)
    if (!row) return null
    let stage: MaterialStage
    if (row.status === 'failed') stage = 'failed'
    else if (row.status === 'done') stage = 'done'
    else if (row.status === 'queued') stage = 'queued'
    else if (row.readAt === null) stage = 'reading'
    else stage = modelReady ? 'embedding' : 'waiting-for-model'
    return {
      id: row.id,
      sessionId: row.sessionId,
      name: row.name,
      kind: row.kind,
      byteSize: row.byteSize,
      status: row.status,
      stage,
      error: row.error,
      pageCount: row.pageCount,
      pagesDone: row.pagesDone,
      pagesFailed: row.pagesFailed,
      pagesOcr: row.pagesOcr,
      pagesMathHeavy: row.pagesMathHeavy,
      pagesFigureHeavy: row.pagesFigureHeavy,
      chunkCount: row.chunkCount,
      chunksEmbedded: row.chunksEmbedded,
      timings: { extractMs: row.extractMs, ocrMs: row.ocrMs, embedMs: row.embedMs },
      addedAt: row.addedAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt
    }
  }

  // Pages

  processedPageIndexes(materialId: number): Set<number> {
    const rows = this.db.prepare<[number], { i: number }>('SELECT page_index AS i FROM pages WHERE material_id = ?').all(materialId)
    return new Set(rows.map((r) => r.i))
  }

  insertPage(p: NewPage): void {
    this.db
      .prepare(
        `INSERT INTO pages (session_id, material_id, page_index, page_label, status, method, text, lines, height,
           scanned, math_heavy, figure_heavy, ocr_confidence, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        p.sessionId,
        p.materialId,
        p.pageIndex,
        p.pageLabel,
        p.status,
        p.method,
        p.lines.map((l) => l.text).join('\n'),
        JSON.stringify(p.lines),
        p.height,
        p.scanned ? 1 : 0,
        p.mathHeavy ? 1 : 0,
        p.figureHeavy ? 1 : 0,
        p.ocrConfidence,
        p.error
      )
  }

  /**
   * Pages `from`..`to` (inclusive) that have been read, in order. With `withTranscripts`, a page a
   * vision model transcribed has its transcription in place of its extracted lines.
   */
  loadPages(materialId: number, from: number, to: number, withTranscripts = false): StoredPage[] {
    return this.db
      .prepare<[number, number, number], { index: number; height: number; lines: string; blocks: string | null }>(
        `SELECT p.page_index AS "index", p.height, p.lines, t.blocks FROM pages p
         LEFT JOIN page_transcripts t ON t.material_id = p.material_id AND t.page_index = p.page_index
         WHERE p.material_id = ? AND p.page_index BETWEEN ? AND ? ORDER BY p.page_index`
      )
      .all(materialId, from, to)
      .map((r) => {
        const lines = JSON.parse(r.lines) as TextLine[]
        const transcribed = withTranscripts && r.blocks !== null ? transcribedLines(lines, JSON.parse(r.blocks) as TranscriptBlock[]) : null
        return { index: r.index, height: r.height, lines: transcribed ?? lines }
      })
  }

  /** A page's extracted lines and flags, for sending it to a vision model. */
  pageForVision(materialId: number, pageIndex: number): PageForVision | undefined {
    const row = this.db
      .prepare<[number, number], { label: string | null; lines: string; mathHeavy: number; figureHeavy: number }>(
        `SELECT page_label AS label, lines, math_heavy AS mathHeavy, figure_heavy AS figureHeavy FROM pages
         WHERE material_id = ? AND page_index = ? AND status = 'done'`
      )
      .get(materialId, pageIndex)
    if (!row) return undefined
    return { materialId, pageIndex, label: row.label, lines: JSON.parse(row.lines) as TextLine[], mathHeavy: row.mathHeavy === 1, figureHeavy: row.figureHeavy === 1 }
  }

  /** Pages from..to of a material that were flagged as math-heavy or figure-heavy. */
  flaggedPages(materialId: number, from: number, to: number): number[] {
    return this.db
      .prepare<[number, number, number], { i: number }>(
        `SELECT page_index AS i FROM pages WHERE material_id = ? AND page_index BETWEEN ? AND ? AND status = 'done'
           AND (math_heavy = 1 OR figure_heavy = 1) ORDER BY page_index`
      )
      .all(materialId, from, to)
      .map((r) => r.i)
  }

  hasTranscript(materialId: number, pageIndex: number): boolean {
    return this.db.prepare('SELECT 1 FROM page_transcripts WHERE material_id = ? AND page_index = ?').get(materialId, pageIndex) !== undefined
  }

  /** Sets printed page numbers; pages not in `labels` keep theirs. */
  updatePageLabels(materialId: number, labels: Map<number, string>): void {
    const update = this.db.prepare('UPDATE pages SET page_label = ? WHERE material_id = ? AND page_index = ? AND page_label IS NOT ?')
    this.db.transaction(() => {
      for (const [index, label] of labels) update.run(label, materialId, index, label)
    })()
  }

  pageIssues(materialId: number): PageIssue[] {
    return this.db
      .prepare<
        [number],
        { pageIndex: number; pageLabel: string | null; status: string; error: string | null; method: string | null; ocrConfidence: number | null; mathHeavy: number; figureHeavy: number }
      >(
        `SELECT page_index AS pageIndex, page_label AS pageLabel, status, error, method, ocr_confidence AS ocrConfidence,
           math_heavy AS mathHeavy, figure_heavy AS figureHeavy
         FROM pages WHERE material_id = ? AND (status = 'failed' OR method = 'ocr' OR math_heavy = 1 OR figure_heavy = 1)
         ORDER BY page_index`
      )
      .all(materialId)
      .map((r) => ({
        pageIndex: r.pageIndex,
        pageLabel: r.pageLabel,
        failed: r.status === 'failed',
        error: r.error,
        ocr: r.method === 'ocr',
        ocrConfidence: r.ocrConfidence,
        mathHeavy: r.mathHeavy === 1,
        figureHeavy: r.figureHeavy === 1
      }))
  }

  // Sections and chunks

  getSection(id: number): SectionRow | undefined {
    return this.db.prepare<[number], SectionRow>(`SELECT ${SECTION_COLUMNS} FROM sections WHERE id = ?`).get(id)
  }

  sessionSections(sessionId: number): SectionRow[] {
    return this.db.prepare<[number], SectionRow>(`SELECT ${SECTION_COLUMNS} FROM sections WHERE session_id = ? ORDER BY material_id, ordinal`).all(sessionId)
  }

  /** Where a section starts and ends, or undefined if the section or its material is gone. */
  sectionBounds(id: number): SectionBounds | undefined {
    const section = this.getSection(id)
    if (!section) return undefined
    const material = this.getMaterial(section.materialId)
    if (!material) return undefined
    const nextRow = this.db
      .prepare<[number, number], SectionRow>(`SELECT ${SECTION_COLUMNS} FROM sections WHERE material_id = ? AND ordinal = ?`)
      .get(section.materialId, section.ordinal + 1)
    const toStart = (r: SectionRow): SectionStart => ({ chapter: r.chapter, section: r.section, startPage: r.startPage, startY: r.startY })
    const next = nextRow ? toStart(nextRow) : null
    // A section ends on the page where the next one starts when that one starts below the top.
    const lastPage = next ? Math.max(section.startPage, next.startY > 0 ? next.startPage : next.startPage - 1) : (material.pageCount ?? section.startPage)
    return { section, material, start: toStart(section), next, lastPage }
  }

  /** Replaces a section's chunks in one transaction; the new chunks wait for vectors. */
  replaceSectionChunks(sectionId: number, chunks: ChunkDraft[]): void {
    const section = this.getSection(sectionId)
    if (!section) throw new Error(`Section ${sectionId} does not exist.`)
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM chunks WHERE section_id = ?').run(sectionId)
      const insert = this.db.prepare(
        `INSERT INTO chunks (session_id, material_id, section_id, ordinal, chapter, section, page_start, page_end, text, original_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      chunks.forEach((c, i) =>
        insert.run(section.sessionId, section.materialId, sectionId, i, section.chapter, section.section, c.pageStart, c.pageEnd, c.text, c.originalText)
      )
    })()
  }

  sectionCount(materialId: number): number {
    return this.db.prepare<[number], { n: number }>('SELECT count(*) AS n FROM sections WHERE material_id = ?').get(materialId)?.n ?? 0
  }

  /** Stores a finished section and its chunks in one transaction, so a crash never leaves half a section. */
  insertSectionWithChunks(
    m: { sessionId: number; materialId: number },
    ordinal: number,
    start: SectionStart,
    source: 'outline' | 'headings' | 'slides' | 'whole',
    chunks: ChunkDraft[]
  ): void {
    this.db.transaction(() => {
      const section = this.db
        .prepare(
          `INSERT INTO sections (session_id, material_id, ordinal, chapter, section, start_page, start_y, source, chunked)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(m.sessionId, m.materialId, ordinal, start.chapter, start.section, start.startPage, start.startY, source)
      const insertChunk = this.db.prepare(
        `INSERT INTO chunks (session_id, material_id, section_id, ordinal, chapter, section, page_start, page_end, text, original_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      chunks.forEach((c, i) =>
        insertChunk.run(m.sessionId, m.materialId, section.lastInsertRowid, i, start.chapter, start.section, c.pageStart, c.pageEnd, c.text, c.originalText)
      )
    })()
  }

  /** Chunks still waiting for a vector, in file order. */
  chunksToEmbed(limit: number): ChunkToEmbed[] {
    return this.db
      .prepare<[number], ChunkToEmbed>(
        `SELECT c.id, c.session_id AS sessionId, c.material_id AS materialId, c.chapter, c.section, c.text
         FROM chunks c JOIN materials m ON m.id = c.material_id
         WHERE c.embedded = 0 AND m.status != 'failed' ORDER BY c.material_id, c.id LIMIT ?`
      )
      .all(limit)
  }

  hasChunksToEmbed(): boolean {
    return this.db.prepare("SELECT 1 FROM chunks c JOIN materials m ON m.id = c.material_id WHERE c.embedded = 0 AND m.status != 'failed' LIMIT 1").get() !== undefined
  }

  storeVectors(items: { chunkId: number; sessionId: number; vector: Float32Array }[]): void {
    const insert = this.db.prepare('INSERT OR REPLACE INTO chunk_vectors (chunk_id, session_id, embedding) VALUES (?, ?, ?)')
    const mark = this.db.prepare('UPDATE chunks SET embedded = 1 WHERE id = ?')
    this.db.transaction(() => {
      for (const item of items) {
        insert.run(BigInt(item.chunkId), BigInt(item.sessionId), item.vector)
        mark.run(item.chunkId)
      }
    })()
  }

  // Search

  keywordSearch(sessionId: number, ftsQuery: string, limit: number): number[] {
    return this.db
      .prepare<[string, number, number], { id: number }>(
        `SELECT c.id FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ? AND c.session_id = ?
         ORDER BY bm25(chunks_fts, 0.5, 1.5, 1.0, 1.0) LIMIT ?`
      )
      .all(ftsQuery, sessionId, limit)
      .map((r) => r.id)
  }

  vectorSearch(sessionId: number, vector: Float32Array, limit: number): number[] {
    return this.db
      .prepare<[Float32Array, number, number], { id: number }>(
        `SELECT chunk_id AS id FROM chunk_vectors WHERE embedding MATCH ? AND k = ? AND session_id = ? ORDER BY distance`
      )
      .all(vector, limit, sessionId)
      .map((r) => r.id)
  }

  /**
   * Passage texts by chunk id, for checking the query's wording against each candidate. `original`
   * is the extracted text that a transcription replaced, or null.
   */
  chunkTexts(ids: number[]): Map<number, { text: string; original: string | null }> {
    const rows = this.db
      .prepare<[string], { id: number; text: string; original: string | null }>(
        'SELECT id, text, original_text AS original FROM chunks WHERE id IN (SELECT value FROM json_each(?))'
      )
      .all(JSON.stringify(ids))
    return new Map(rows.map((r) => [r.id, { text: r.text, original: r.original }]))
  }

  /** Text of a range of pages (the transcription where there is one), in order, with printed page numbers. */
  pageTexts(materialId: number, from: number, to: number): PageText[] {
    return this.db
      .prepare<[number, number, number], PageText>(
        `SELECT p.page_index AS "index", p.page_label AS label, coalesce(t.text, p.text, '') AS text FROM pages p
         LEFT JOIN page_transcripts t ON t.material_id = p.material_id AND t.page_index = p.page_index
         WHERE p.material_id = ? AND p.page_index BETWEEN ? AND ? ORDER BY p.page_index`
      )
      .all(materialId, from, to)
  }

  /** Printed page numbers of a range of pages, in order (null where the page has none). */
  pageLabels(materialId: number, from: number, to: number): { index: number; label: string | null }[] {
    return this.db
      .prepare<[number, number, number], { index: number; label: string | null }>(
        'SELECT page_index AS "index", page_label AS label FROM pages WHERE material_id = ? AND page_index BETWEEN ? AND ? ORDER BY page_index'
      )
      .all(materialId, from, to)
  }

  /** Chunks whose pages include any of these pages, in book order. */
  chunksCoveringPages(materialId: number, pageIndexes: number[]): number[] {
    return this.db
      .prepare<[string, number], { id: number }>(
        `SELECT DISTINCT c.id, c.page_start, c.ordinal FROM json_each(?) p JOIN chunks c ON p.value BETWEEN c.page_start AND c.page_end
         WHERE c.material_id = ? ORDER BY c.page_start, c.ordinal, c.id`
      )
      .all(JSON.stringify(pageIndexes), materialId)
      .map((r) => r.id)
  }

  chunkDetails(ids: number[]): Map<number, ChunkDetails> {
    const get = this.db.prepare<[number], ChunkDetails>(
      `SELECT c.id, c.material_id AS materialId, m.original_name AS fileName, m.kind, c.chapter, c.section,
         c.page_start AS pageStart, c.page_end AS pageEnd, c.text,
         (SELECT page_label FROM pages p WHERE p.material_id = c.material_id AND p.page_index = c.page_start) AS labelStart,
         (SELECT page_label FROM pages p WHERE p.material_id = c.material_id AND p.page_index = c.page_end) AS labelEnd
       FROM chunks c JOIN materials m ON m.id = c.material_id WHERE c.id = ?`
    )
    const map = new Map<number, ChunkDetails>()
    for (const id of ids) {
      const row = get.get(id)
      if (row) map.set(id, row)
    }
    return map
  }
}
