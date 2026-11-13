import type Database from 'better-sqlite3'
import type { JobEstimate, JobKind, JobStatus, SyllabusDraft } from '../../shared/knowledge'
import type { TranscriptBlock } from '../ingestion'
import type { PrereqEdge } from './graph'
import type { ExtractedConcept } from './schemas'

// All SQL for the knowledge tables (migration 3), run on the main process's connection.

export type StepKind = 'syllabus-parse' | 'syllabus-map' | 'transcribe' | 'rechunk' | 'extract' | 'match' | 'build'

export interface JobRow {
  id: number
  sessionId: number
  kind: JobKind
  unitId: number | null
  syllabusId: number | null
  model: string
  status: JobStatus
  pauseReason: string | null
  resumeAt: string | null
  error: string | null
  estimate: JobEstimate
  createdAt: string
  finishedAt: string | null
}

export interface StepRow {
  id: number
  jobId: number
  ordinal: number
  kind: StepKind
  materialId: number | null
  pageIndex: number | null
  sectionId: number | null
  status: 'pending' | 'done' | 'failed'
  error: string | null
}

export interface NewStep {
  kind: StepKind
  materialId?: number
  pageIndex?: number
  sectionId?: number
}

export interface SyllabusRow {
  id: number
  sessionId: number
  sourceName: string
  sha256: string
  text: string
  draft: SyllabusDraft | null
  status: 'awaiting-approval' | 'reading' | 'draft' | 'confirmed'
}

export interface UnitRow {
  id: number
  sessionId: number
  syllabusId: number
  ordinal: number
  title: string
  topics: string[]
  startDate: string | null
  endDate: string | null
  examWeight: number | null
}

export interface MentionRow {
  id: number
  sectionId: number
  ordinal: number
  name: string
  definition: string
  pages: number[]
  prerequisites: string[]
  conceptId: number | null
}

export interface ConceptRow {
  id: number
  sessionId: number
  name: string
  definition: string
  firstMaterialId: number
  firstPage: number
  edited: boolean
}

/** A concept to create or extend when a unit's graph is built. */
export interface BuiltConcept {
  /** An existing concept to extend, or null to create one. */
  existingId: number | null
  name: string
  definition: string
  firstMaterialId: number
  firstPage: number
  pages: { materialId: number; pageIndex: number }[]
  mentionIds: number[]
  vector: Float32Array
  /** Prerequisite names that matched no concept. */
  unresolved: string[]
}

const JOB_COLUMNS = `id, session_id AS sessionId, kind, unit_id AS unitId, syllabus_id AS syllabusId, model, status,
  pause_reason AS pauseReason, resume_at AS resumeAt, error, estimate, created_at AS createdAt, finished_at AS finishedAt`
const STEP_COLUMNS = `id, job_id AS jobId, ordinal, kind, material_id AS materialId, page_index AS pageIndex, section_id AS sectionId, status, error`
const UNIT_COLUMNS = `id, session_id AS sessionId, syllabus_id AS syllabusId, ordinal, title, topics, start_date AS startDate,
  end_date AS endDate, exam_weight AS examWeight`
const CONCEPT_COLUMNS = `id, session_id AS sessionId, name, definition, first_material_id AS firstMaterialId, first_page AS firstPage, edited`

type RawJob = Omit<JobRow, 'estimate'> & { estimate: string }
type RawUnit = Omit<UnitRow, 'topics'> & { topics: string }
type RawConcept = Omit<ConceptRow, 'edited'> & { edited: number }

const toJob = (r: RawJob): JobRow => ({ ...r, estimate: JSON.parse(r.estimate) as JobEstimate })
const toUnit = (r: RawUnit): UnitRow => ({ ...r, topics: JSON.parse(r.topics) as string[] })
const toConcept = (r: RawConcept): ConceptRow => ({ ...r, edited: r.edited === 1 })

export class KnowledgeRepo {
  constructor(readonly db: Database.Database) {}

  // Jobs

  createJob(job: { sessionId: number; kind: JobKind; unitId: number | null; syllabusId: number | null; model: string; estimate: JobEstimate; steps: NewStep[] }): number {
    return this.db.transaction(() => {
      const id = Number(
        this.db
          .prepare(`INSERT INTO knowledge_jobs (session_id, kind, unit_id, syllabus_id, model, status, estimate) VALUES (?, ?, ?, ?, ?, 'awaiting-approval', ?)`)
          .run(job.sessionId, job.kind, job.unitId, job.syllabusId, job.model, JSON.stringify(job.estimate)).lastInsertRowid
      )
      const insert = this.db.prepare('INSERT INTO job_steps (job_id, ordinal, kind, material_id, page_index, section_id) VALUES (?, ?, ?, ?, ?, ?)')
      job.steps.forEach((s, i) => insert.run(id, i, s.kind, s.materialId ?? null, s.pageIndex ?? null, s.sectionId ?? null))
      return id
    })()
  }

  getJob(id: number): JobRow | undefined {
    const row = this.db.prepare<[number], RawJob>(`SELECT ${JOB_COLUMNS} FROM knowledge_jobs WHERE id = ?`).get(id)
    return row ? toJob(row) : undefined
  }

  jobsOfSession(sessionId: number): JobRow[] {
    return this.db.prepare<[number], RawJob>(`SELECT ${JOB_COLUMNS} FROM knowledge_jobs WHERE session_id = ? ORDER BY id DESC`).all(sessionId).map(toJob)
  }

  lastJobOfUnit(unitId: number): JobRow | undefined {
    const row = this.db.prepare<[number], RawJob>(`SELECT ${JOB_COLUMNS} FROM knowledge_jobs WHERE unit_id = ? ORDER BY id DESC LIMIT 1`).get(unitId)
    return row ? toJob(row) : undefined
  }

  /** Jobs that were running (or paused with a resume time) when the app last stopped. */
  jobsToResume(): JobRow[] {
    return this.db.prepare<[], RawJob>(`SELECT ${JOB_COLUMNS} FROM knowledge_jobs WHERE status IN ('running', 'paused') ORDER BY id`).all().map(toJob)
  }

  /** A job that has not finished in this session: running, paused or waiting for approval. */
  openJobs(sessionId: number): JobRow[] {
    return this.db
      .prepare<[number], RawJob>(`SELECT ${JOB_COLUMNS} FROM knowledge_jobs WHERE session_id = ? AND status IN ('awaiting-approval', 'running', 'paused') ORDER BY id`)
      .all(sessionId)
      .map(toJob)
  }

  setJobStatus(id: number, status: JobStatus, extra: { pauseReason?: string | null; resumeAt?: string | null; error?: string | null } = {}): void {
    const finished = status === 'done' || status === 'failed' || status === 'cancelled'
    this.db
      .prepare(
        `UPDATE knowledge_jobs SET status = ?, pause_reason = ?, resume_at = ?, error = ?,
           approved_at = CASE WHEN ? = 'running' THEN coalesce(approved_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE approved_at END,
           finished_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
         WHERE id = ?`
      )
      .run(status, extra.pauseReason ?? null, extra.resumeAt ?? null, extra.error ?? null, status, finished ? 1 : 0, id)
  }

  steps(jobId: number): StepRow[] {
    return this.db.prepare<[number], StepRow>(`SELECT ${STEP_COLUMNS} FROM job_steps WHERE job_id = ? ORDER BY ordinal`).all(jobId)
  }

  markStep(stepId: number, status: 'pending' | 'done' | 'failed', error: string | null = null): void {
    this.db.prepare('UPDATE job_steps SET status = ?, error = ? WHERE id = ?').run(status, error, stepId)
  }

  // Syllabus and units

  createSyllabus(s: { sessionId: number; sourceName: string; sha256: string; text: string }): number {
    return Number(
      this.db
        .prepare(`INSERT INTO syllabi (session_id, source_name, sha256, text, status) VALUES (?, ?, ?, ?, 'awaiting-approval')`)
        .run(s.sessionId, s.sourceName, s.sha256, s.text).lastInsertRowid
    )
  }

  getSyllabus(id: number): SyllabusRow | undefined {
    const row = this.db
      .prepare<[number], Omit<SyllabusRow, 'draft'> & { draft: string | null }>(
        'SELECT id, session_id AS sessionId, source_name AS sourceName, sha256, text, draft, status FROM syllabi WHERE id = ?'
      )
      .get(id)
    return row ? { ...row, draft: row.draft ? (JSON.parse(row.draft) as SyllabusDraft) : null } : undefined
  }

  /** The newest syllabus of the session, whatever its state. */
  latestSyllabus(sessionId: number): SyllabusRow | undefined {
    const row = this.db.prepare<[number], { id: number }>('SELECT id FROM syllabi WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId)
    return row ? this.getSyllabus(row.id) : undefined
  }

  setSyllabusDraft(id: number, draft: SyllabusDraft | null, status: SyllabusRow['status']): void {
    this.db.prepare('UPDATE syllabi SET draft = ?, status = ? WHERE id = ?').run(draft ? JSON.stringify(draft) : null, status, id)
  }

  /**
   * Saves the user's corrected syllabus as the session's units, replacing any earlier syllabus
   * (its units, and their links to concepts, go with it).
   */
  confirmSyllabus(id: number, draft: SyllabusDraft, sectionIdsOf: (tocKey: string) => number[]): void {
    const syllabus = this.getSyllabus(id)
    if (!syllabus) throw new Error('That syllabus no longer exists.')
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM syllabi WHERE session_id = ? AND id != ?').run(syllabus.sessionId, id)
      this.db.prepare('DELETE FROM units WHERE syllabus_id = ?').run(id)
      this.db.prepare('DELETE FROM exams WHERE syllabus_id = ?').run(id)
      const insertUnit = this.db.prepare(
        'INSERT INTO units (session_id, syllabus_id, ordinal, title, topics, start_date, end_date, exam_weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      const insertSection = this.db.prepare('INSERT OR IGNORE INTO unit_sections (unit_id, section_id) VALUES (?, ?)')
      const unitIds = draft.units.map((u, i) => {
        const unitId = Number(insertUnit.run(syllabus.sessionId, id, i, u.title, JSON.stringify(u.topics), u.startDate, u.endDate, u.examWeight).lastInsertRowid)
        for (const key of u.tocKeys) for (const sectionId of sectionIdsOf(key)) insertSection.run(unitId, sectionId)
        return unitId
      })
      const insertExam = this.db.prepare('INSERT INTO exams (session_id, syllabus_id, ordinal, title, date, weight) VALUES (?, ?, ?, ?, ?, ?)')
      const insertExamUnit = this.db.prepare('INSERT OR IGNORE INTO exam_units (exam_id, unit_id) VALUES (?, ?)')
      draft.exams.forEach((e, i) => {
        const examId = Number(insertExam.run(syllabus.sessionId, id, i, e.title, e.date, e.weight).lastInsertRowid)
        for (const u of e.units) {
          const unitId = unitIds[u]
          if (unitId !== undefined) insertExamUnit.run(examId, unitId)
        }
      })
      this.db.prepare(`UPDATE syllabi SET draft = ?, status = 'confirmed', confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(JSON.stringify(draft), id)
    })()
  }

  units(sessionId: number): UnitRow[] {
    return this.db
      .prepare<[number, number], RawUnit>(
        `SELECT ${UNIT_COLUMNS} FROM units WHERE session_id = ? AND syllabus_id = (SELECT id FROM syllabi WHERE session_id = ? AND status = 'confirmed' ORDER BY id DESC LIMIT 1) ORDER BY ordinal`
      )
      .all(sessionId, sessionId)
      .map(toUnit)
  }

  getUnit(id: number): UnitRow | undefined {
    const row = this.db.prepare<[number], RawUnit>(`SELECT ${UNIT_COLUMNS} FROM units WHERE id = ?`).get(id)
    return row ? toUnit(row) : undefined
  }

  unitSectionIds(unitId: number): number[] {
    return this.db
      .prepare<[number], { id: number }>(
        `SELECT us.section_id AS id FROM unit_sections us JOIN sections s ON s.id = us.section_id WHERE us.unit_id = ? ORDER BY s.material_id, s.ordinal`
      )
      .all(unitId)
      .map((r) => r.id)
  }

  // Transcripts

  saveTranscript(t: { sessionId: number; materialId: number; pageIndex: number; blocks: TranscriptBlock[]; cacheKey: string }): void {
    this.db
      .prepare('INSERT OR REPLACE INTO page_transcripts (session_id, material_id, page_index, blocks, text, cache_key) VALUES (?, ?, ?, ?, ?, ?)')
      .run(t.sessionId, t.materialId, t.pageIndex, JSON.stringify(t.blocks), t.blocks.map((b) => b.text).join('\n\n'), t.cacheKey)
  }

  transcriptKey(materialId: number, pageIndex: number): string | undefined {
    return this.db
      .prepare<[number, number], { key: string }>('SELECT cache_key AS key FROM page_transcripts WHERE material_id = ? AND page_index = ?')
      .get(materialId, pageIndex)?.key
  }

  // Mentions

  /** Replaces what extraction found in a section, keeping nothing from an earlier extraction. */
  replaceMentions(sessionId: number, sectionId: number, cacheKey: string, concepts: ExtractedConcept[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM concept_mentions WHERE section_id = ?').run(sectionId)
      const insert = this.db.prepare(
        'INSERT INTO concept_mentions (session_id, section_id, ordinal, name, definition, pages, prerequisites, cache_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      concepts.forEach((c, i) => insert.run(sessionId, sectionId, i, c.name, c.definition, JSON.stringify(c.pages), JSON.stringify(c.prerequisites), cacheKey))
    })()
  }

  mentionsKey(sectionId: number): string | undefined {
    return this.db.prepare<[number], { key: string }>('SELECT cache_key AS key FROM concept_mentions WHERE section_id = ? LIMIT 1').get(sectionId)?.key
  }

  mentions(sectionIds: number[]): MentionRow[] {
    return this.db
      .prepare<[string], Omit<MentionRow, 'pages' | 'prerequisites'> & { pages: string; prerequisites: string }>(
        `SELECT id, section_id AS sectionId, ordinal, name, definition, pages, prerequisites, concept_id AS conceptId
         FROM concept_mentions WHERE section_id IN (SELECT value FROM json_each(?)) ORDER BY id`
      )
      .all(JSON.stringify(sectionIds))
      .map((r) => ({ ...r, pages: JSON.parse(r.pages) as number[], prerequisites: JSON.parse(r.prerequisites) as string[] }))
  }

  // Concepts

  getConcept(id: number): ConceptRow | undefined {
    const row = this.db.prepare<[number], RawConcept>(`SELECT ${CONCEPT_COLUMNS} FROM concepts WHERE id = ?`).get(id)
    return row ? toConcept(row) : undefined
  }

  concepts(sessionId: number): ConceptRow[] {
    return this.db.prepare<[number], RawConcept>(`SELECT ${CONCEPT_COLUMNS} FROM concepts WHERE session_id = ? ORDER BY id`).all(sessionId).map(toConcept)
  }

  conceptsOfUnit(unitId: number): ConceptRow[] {
    return this.db
      .prepare<[number], RawConcept>(`SELECT ${CONCEPT_COLUMNS} FROM concepts WHERE id IN (SELECT concept_id FROM concept_units WHERE unit_id = ?) ORDER BY id`)
      .all(unitId)
      .map(toConcept)
  }

  conceptCount(unitId: number): number {
    return this.db.prepare<[number], { n: number }>('SELECT count(*) AS n FROM concept_units WHERE unit_id = ?').get(unitId)?.n ?? 0
  }

  /** Names a concept has gone by: its own and those of the mentions merged into it. */
  conceptNames(conceptId: number): string[] {
    const own = this.getConcept(conceptId)?.name
    const mentioned = this.db.prepare<[number], { name: string }>('SELECT DISTINCT name FROM concept_mentions WHERE concept_id = ?').all(conceptId).map((r) => r.name)
    return [...new Set([...(own ? [own] : []), ...mentioned])]
  }

  conceptPages(conceptId: number): { materialId: number; pageIndex: number }[] {
    return this.db
      .prepare<[number], { materialId: number; pageIndex: number }>(
        'SELECT material_id AS materialId, page_index AS pageIndex FROM concept_pages WHERE concept_id = ? ORDER BY material_id, page_index'
      )
      .all(conceptId)
  }

  conceptVectors(sessionId: number, excludeIds: number[]): Map<number, Float32Array> {
    const rows = this.db
      .prepare<[number, string], { id: number; embedding: Buffer }>(
        'SELECT concept_id AS id, embedding FROM concept_vectors WHERE session_id = ? AND concept_id NOT IN (SELECT value FROM json_each(?))'
      )
      .all(sessionId, JSON.stringify(excludeIds))
    return new Map(rows.map((r) => [r.id, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)]))
  }

  unresolved(conceptId: number): string[] {
    return this.db.prepare<[number], { name: string }>('SELECT name FROM concept_unresolved WHERE concept_id = ? ORDER BY name').all(conceptId).map((r) => r.name)
  }

  /** Every prerequisite link in the session, with its state. */
  links(sessionId: number): (PrereqEdge & { status: 'active' | 'removed-cycle' | 'removed-user'; reason: string | null })[] {
    return this.db
      .prepare<[number], PrereqEdge & { status: 'active' | 'removed-cycle' | 'removed-user'; reason: string | null }>(
        `SELECT p.concept_id AS concept, p.prereq_id AS prereq, p.source, p.status, p.reason FROM concept_prereqs p
         JOIN concepts c ON c.id = p.concept_id WHERE c.session_id = ?`
      )
      .all(sessionId)
  }

  activeEdges(sessionId: number): PrereqEdge[] {
    return this.links(sessionId).filter((l) => l.status === 'active').map(({ concept, prereq, source }) => ({ concept, prereq, source }))
  }

  setLink(concept: number, prereq: number, source: 'extracted' | 'user', status: 'active' | 'removed-cycle' | 'removed-user', reason: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO concept_prereqs (concept_id, prereq_id, source, status, reason) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (concept_id, prereq_id) DO UPDATE SET source = excluded.source, status = excluded.status, reason = excluded.reason`
      )
      .run(concept, prereq, source, status, reason)
  }

  getLink(concept: number, prereq: number): { source: 'extracted' | 'user'; status: string } | undefined {
    return this.db
      .prepare<[number, number], { source: 'extracted' | 'user'; status: string }>('SELECT source, status FROM concept_prereqs WHERE concept_id = ? AND prereq_id = ?')
      .get(concept, prereq)
  }

  /** Units a concept belongs to. */
  conceptUnitIds(conceptId: number): number[] {
    return this.db.prepare<[number], { id: number }>('SELECT unit_id AS id FROM concept_units WHERE concept_id = ?').all(conceptId).map((r) => r.id)
  }

  /**
   * Writes a unit's graph in one transaction: removes concepts that belonged only to this unit
   * (a rebuild), then creates or extends the built concepts and links their prerequisites.
   * `prereqs` uses indexes into `concepts` for new links; `existing` ids for links to concepts
   * already in the session.
   */
  writeUnitGraph(
    sessionId: number,
    unitId: number,
    concepts: BuiltConcept[],
    prereqs: { concept: number; prereq: { index: number } | { existingId: number } }[]
  ): number[] {
    return this.db.transaction(() => {
      const keep = new Set(concepts.map((c) => c.existingId).filter((id): id is number => id !== null))
      // A rebuild: this unit's own concepts are replaced; concepts shared with other units stay.
      const old = this.db
        .prepare<[number], { id: number; units: number }>(
          `SELECT cu.concept_id AS id, (SELECT count(*) FROM concept_units x WHERE x.concept_id = cu.concept_id) AS units
           FROM concept_units cu WHERE cu.unit_id = ?`
        )
        .all(unitId)
      for (const o of old) {
        if (o.units === 1 && !keep.has(o.id)) this.db.prepare('DELETE FROM concepts WHERE id = ?').run(o.id)
      }
      this.db.prepare('DELETE FROM concept_units WHERE unit_id = ?').run(unitId)

      const insertConcept = this.db.prepare('INSERT INTO concepts (session_id, name, definition, first_material_id, first_page) VALUES (?, ?, ?, ?, ?)')
      const updateFirst = this.db.prepare(
        `UPDATE concepts SET first_material_id = ?, first_page = ? WHERE id = ? AND (first_material_id > ? OR (first_material_id = ? AND first_page > ?))`
      )
      const insertPage = this.db.prepare('INSERT OR IGNORE INTO concept_pages (concept_id, material_id, page_index) VALUES (?, ?, ?)')
      const insertUnit = this.db.prepare('INSERT OR IGNORE INTO concept_units (concept_id, unit_id) VALUES (?, ?)')
      const setMention = this.db.prepare('UPDATE concept_mentions SET concept_id = ? WHERE id = ?')
      const insertVector = this.db.prepare('INSERT OR REPLACE INTO concept_vectors (concept_id, session_id, embedding) VALUES (?, ?, ?)')
      const insertUnresolved = this.db.prepare('INSERT OR IGNORE INTO concept_unresolved (concept_id, name) VALUES (?, ?)')

      const ids = concepts.map((c) => {
        let id: number
        if (c.existingId !== null) {
          id = c.existingId
          updateFirst.run(c.firstMaterialId, c.firstPage, id, c.firstMaterialId, c.firstMaterialId, c.firstPage)
        } else {
          id = Number(insertConcept.run(sessionId, c.name, c.definition, c.firstMaterialId, c.firstPage).lastInsertRowid)
          insertVector.run(BigInt(id), BigInt(sessionId), c.vector)
        }
        for (const p of c.pages) insertPage.run(id, p.materialId, p.pageIndex)
        insertUnit.run(id, unitId)
        for (const m of c.mentionIds) setMention.run(id, m)
        for (const name of c.unresolved) insertUnresolved.run(id, name)
        return id
      })
      for (const link of prereqs) {
        const concept = ids[link.concept]
        const prereq = 'index' in link.prereq ? ids[link.prereq.index] : link.prereq.existingId
        if (concept === undefined || prereq === undefined || concept === prereq) continue
        const existing = this.getLink(concept, prereq)
        // Never undo the user's own decisions about a link.
        if (existing && (existing.source === 'user' || existing.status === 'removed-user')) continue
        this.setLink(concept, prereq, 'extracted', 'active')
      }
      return ids
    })()
  }

  // Edits from the review screen

  renameConcept(id: number, name: string, definition: string | null): void {
    if (definition === null) this.db.prepare('UPDATE concepts SET name = ?, edited = 1 WHERE id = ?').run(name, id)
    else this.db.prepare('UPDATE concepts SET name = ?, definition = ?, edited = 1 WHERE id = ?').run(name, definition, id)
  }

  deleteConcept(id: number): void {
    this.db.prepare('DELETE FROM concepts WHERE id = ?').run(id)
  }

  /** Moves everything of `from` onto `into` and deletes `from`. Links between the two disappear. */
  mergeConcepts(from: number, into: number): void {
    this.db.transaction(() => {
      const source = this.getConcept(from)
      if (!source) throw new Error('That concept no longer exists.')
      this.db.prepare('INSERT OR IGNORE INTO concept_pages (concept_id, material_id, page_index) SELECT ?, material_id, page_index FROM concept_pages WHERE concept_id = ?').run(into, from)
      this.db.prepare('INSERT OR IGNORE INTO concept_units (concept_id, unit_id) SELECT ?, unit_id FROM concept_units WHERE concept_id = ?').run(into, from)
      this.db.prepare('INSERT OR IGNORE INTO concept_unresolved (concept_id, name) SELECT ?, name FROM concept_unresolved WHERE concept_id = ?').run(into, from)
      this.db.prepare('UPDATE concept_mentions SET concept_id = ? WHERE concept_id = ?').run(into, from)
      // Re-point links, skipping ones that would become self-links or duplicates.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO concept_prereqs (concept_id, prereq_id, source, status, reason)
           SELECT ?, prereq_id, source, status, reason FROM concept_prereqs WHERE concept_id = ? AND prereq_id != ?`
        )
        .run(into, from, into)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO concept_prereqs (concept_id, prereq_id, source, status, reason)
           SELECT concept_id, ?, source, status, reason FROM concept_prereqs WHERE prereq_id = ? AND concept_id != ?`
        )
        .run(into, from, into)
      this.db
        .prepare('UPDATE concepts SET first_material_id = ?, first_page = ? WHERE id = ? AND (first_material_id > ? OR (first_material_id = ? AND first_page > ?))')
        .run(source.firstMaterialId, source.firstPage, into, source.firstMaterialId, source.firstMaterialId, source.firstPage)
      this.db.prepare('UPDATE concepts SET edited = 1 WHERE id = ?').run(into)
      this.db.prepare('DELETE FROM concepts WHERE id = ?').run(from)
    })()
  }
}
