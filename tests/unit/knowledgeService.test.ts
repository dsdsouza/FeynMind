import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chunkSection } from '../../src/main/ingestion/chunker'
import { IngestionReader } from '../../src/main/ingestion/reader'
import { IngestionRepo } from '../../src/main/ingestion/repo'
import type { TextLine } from '../../src/main/ingestion/types'
import { KnowledgeService, PromptLibrary } from '../../src/main/knowledge'
import { ProviderError, ProviderService, UsageStore, type GenerateRequest } from '../../src/main/providers'
import { openDatabase, SessionStore, SettingsStore } from '../../src/main/storage'
import type { DraftUnit, SyllabusDraft } from '../../src/shared/knowledge'
import type Database from 'better-sqlite3'
import { createFakeEmbedder } from './fakes/fakeEmbedder'
import { FakeClock } from './fakes/fakeClock'
import { FakeEncryptor, FakeProvider, type FakeAnswer } from './fakes/fakeProvider'

const PROMPTS = join(import.meta.dirname, '..', '..', 'prompts')
const line = (text: string, y: number): TextLine => ({ text, x: 72, y, size: 10, bold: false })

/** A small book: section 1.1 on pages 1-2 (page 2 math-heavy), section 1.2 on pages 3-4. */
function seedBook(db: Database.Database, sessionId: number): { repo: IngestionRepo; materialId: number } {
  const repo = new IngestionRepo(db)
  const materialId = repo.insertMaterial({ sessionId, sha256: 'book-sha', originalName: 'book.pdf', storedName: 'book-sha.pdf', kind: 'pdf', byteSize: 1 })
  repo.startMaterial(materialId, 4, 'outline')
  const pages: [number, string[], boolean][] = [
    [1, ['A vector has a length and a direction.'], false],
    [2, ['The dot product u v = u1 v1 + u2 v2.', 'Length is the square root of the dot product.'], true],
    [3, ['Dot products of columns give matrix entries.'], false],
    [4, ['A matrix is a table of numbers built from vectors.'], false]
  ]
  for (const [index, lines, math] of pages) {
    repo.insertPage({
      sessionId, materialId, pageIndex: index, pageLabel: String(index + 10), status: 'done', method: 'text',
      lines: lines.map((t, i) => line(t, 100 + 20 * i)), height: 792, scanned: false, mathHeavy: math, figureHeavy: false, ocrConfidence: null, error: null
    })
  }
  const sections = [
    { chapter: '1 Vectors', section: '1.1 Vectors and lengths', startPage: 1, startY: 0 },
    { chapter: '1 Vectors', section: '1.2 Matrices', startPage: 3, startY: 0 }
  ]
  sections.forEach((s, i) => {
    const next = sections[i + 1] ?? null
    const chunks = chunkSection(repo.loadPages(materialId, s.startPage, next ? next.startPage : 4), s, next, 10)
    repo.insertSectionWithChunks({ sessionId, materialId }, i, s, 'outline', chunks)
  })
  return { repo, materialId }
}

const reply = (value: unknown): FakeAnswer => ({ text: JSON.stringify(value), inputTokens: 500, outputTokens: 100 })

/** Answers each kind of request the way a well-behaved model would. */
function answer(request: GenerateRequest): FakeAnswer {
  const keys = Object.keys((request.jsonSchema?.['properties'] ?? {}) as object)
  if (keys.includes('exams')) {
    return reply({
      units: [
        { title: 'Vectors', topics: ['vectors', 'dot product'], startDate: '2026-09-01', endDate: '2026-09-14', examWeight: null, readings: ['1.1'] },
        { title: 'Matrices', topics: ['matrices'], startDate: null, endDate: null, examWeight: null, readings: ['1.2'] }
      ],
      exams: [{ title: 'Midterm', date: '2026-10-15', weight: 30, units: [0, 1] }]
    })
  }
  if (keys.includes('units')) return reply({ units: [{ unit: 0, toc: ['T1'] }, { unit: 1, toc: ['T2'] }] })
  if (keys.includes('blocks')) return reply({ blocks: [{ fromLine: 0, text: 'The dot product $u \\cdot v = u_1 v_1 + u_2 v_2$.' }, { fromLine: 1, text: 'Length is $\\|v\\| = \\sqrt{v \\cdot v}$.' }] })
  if (keys.includes('answers')) {
    const ids = [...request.prompt.matchAll(/^([PQ]\d+) \(/gm)].map((m) => m[1])
    return reply({ answers: ids.map((pair) => ({ pair, same: false })) })
  }
  if (request.prompt.includes('[page 1]')) {
    return reply({
      concepts: [
        { name: 'vector', definition: 'A quantity with length and direction.', pages: [1], prerequisites: [] },
        { name: 'dot product', definition: 'The sum $u_1v_1 + u_2v_2$.', pages: [2], prerequisites: ['vectors', 'length'] },
        { name: 'length', definition: 'The square root of $v \\cdot v$.', pages: [2], prerequisites: ['dot product'] }
      ]
    })
  }
  return reply({
    concepts: [
      { name: 'Dot products', definition: 'Multiply matching components and add.', pages: [3], prerequisites: ['vector'] },
      { name: 'matrix', definition: 'A rectangular table of numbers.', pages: [4], prerequisites: ['vector', 'set theory'] }
    ]
  })
}

function setup(db = openDatabase(':memory:'), provider = new FakeProvider()) {
  const sessions = new SessionStore(db)
  const session = sessions.current()
  const settings = new SettingsStore(db)
  settings.set('provider.gemini.model', 'gemini-3.1-flash-lite')
  provider.respond = answer
  const providers = new ProviderService({
    settings,
    encryptor: new FakeEncryptor(),
    createAdapter: provider.factory,
    devKey: 'dev-key',
    loadPrompt: () => '',
    usage: new UsageStore(db),
    limits: (id) => sessions.limits(id),
    clock: new FakeClock()
  })
  const ingestionRepo = new IngestionRepo(db)
  const embedder = createFakeEmbedder()
  const rechunked: number[] = []
  const jobs: string[] = []
  const knowledge = new KnowledgeService({
    db,
    providers,
    ingestion: {
      reader: new IngestionReader(ingestionRepo),
      readText: async () => ({ name: 'syllabus.pdf', sha256: 'syl', text: 'Syllabus text' }),
      renderForVision: async () => new Uint8Array([137, 80, 78, 71]),
      rechunkSections: async (ids) => {
        for (const id of ids) {
          const b = ingestionRepo.sectionBounds(id)
          if (!b) throw new Error('gone')
          ingestionRepo.replaceSectionChunks(id, chunkSection(ingestionRepo.loadPages(b.material.id, b.start.startPage, b.next?.startPage ?? b.lastPage, true), b.start, b.next, 10))
          rechunked.push(id)
        }
        return { chunks: 1 }
      },
      embedTexts: (texts) => embedder.embedPassages(texts)
    },
    prompts: new PromptLibrary((name) => readFileSync(join(PROMPTS, `${name}.txt`), 'utf8').trim()),
    settings,
    limits: (id) => sessions.limits(id),
    onJob: (job) => jobs.push(`${job.id}:${job.status}`),
    onUsage: () => undefined
  })
  return { db, session, sessions, settings, provider, providers, knowledge, rechunked, jobs }
}

const SYLLABUS = 'MATH 101 Linear algebra. Week 1-2: Vectors (read 1.1). Week 3: Matrices (read 1.2). Midterm Oct 15, 30%.'

async function confirmSyllabus(t: ReturnType<typeof setup>): Promise<number[]> {
  const state = t.knowledge.startSyllabusFromText(t.session.id, SYLLABUS)
  t.knowledge.giveConsent(t.session.id)
  t.knowledge.approve(state.job?.id ?? 0)
  await t.knowledge.idle()
  const read = t.knowledge.syllabusState(t.session.id)
  if (!read?.draft) throw new Error('no draft')
  return t.knowledge.saveSyllabus(read.id, read.draft).map((u) => u.id)
}

describe('syllabus import', () => {
  it('estimates, waits for approval and consent, reads the syllabus, maps units to sections, and saves the corrected version', async () => {
    const t = setup()
    seedBook(t.db, t.session.id)
    const state = t.knowledge.startSyllabusFromText(t.session.id, SYLLABUS)
    expect(state.status).toBe('awaiting-approval')
    expect(state.job?.estimate.calls).toBe(2)
    expect(state.toc.map((e) => e.section)).toEqual(['1.1 Vectors and lengths', '1.2 Matrices'])
    expect(t.provider.generateCalls).toHaveLength(0)

    expect(() => t.knowledge.approve(state.job?.id ?? 0)).toThrow(/notice/)
    expect(t.knowledge.consent(t.session.id)).toMatchObject({ provider: 'Google Gemini', given: false })
    t.knowledge.giveConsent(t.session.id)
    t.knowledge.approve(state.job?.id ?? 0)
    await t.knowledge.idle()

    const read = t.knowledge.syllabusState(t.session.id)
    expect(read?.status).toBe('draft')
    expect(read?.job?.status).toBe('done')
    expect(read?.draft?.units.map((u) => [u.title, u.tocKeys.length])).toEqual([['Vectors', 1], ['Matrices', 1]])
    expect(t.provider.generateCalls).toHaveLength(2)

    // The user corrects a title before saving.
    const draft = read?.draft ?? { units: [], exams: [] }
    draft.units[1] = { ...(draft.units[1] as (typeof draft.units)[number]), title: 'Matrices and tables' }
    const units = t.knowledge.saveSyllabus(read?.id ?? 0, draft)
    expect(units.map((u) => [u.title, u.sections.length, u.startDate])).toEqual([['Vectors', 1, '2026-09-01'], ['Matrices and tables', 1, null]])
    expect(() => t.knowledge.saveSyllabus(read?.id ?? 0, { units: [{ ...(draft.units[0] as (typeof draft.units)[number]), startDate: 'soon' }], exams: [] })).toThrow(/date/)
  })
})

describe('unit processing', () => {
  it('estimates, then transcribes, re-chunks, extracts, merges duplicates and breaks loops', async () => {
    const t = setup()
    seedBook(t.db, t.session.id)
    const [unit1] = await confirmSyllabus(t)
    const callsBefore = t.provider.generateCalls.length

    // Unit 1 is section 1.1 only; make it cover both sections to see merging across sections.
    t.db.prepare('INSERT OR IGNORE INTO unit_sections (unit_id, section_id) SELECT ?, id FROM sections').run(unit1)
    const job = t.knowledge.estimateUnit(unit1 ?? 0)
    expect(job.status).toBe('awaiting-approval')
    const byKind = Object.fromEntries(job.estimate.parts.map((p) => [p.kind, p]))
    expect(byKind['transcribe']).toMatchObject({ calls: 1, cached: 0, approximate: false })
    expect(byKind['extract']).toMatchObject({ calls: 2, cached: 0 })
    expect(byKind['match']?.approximate).toBe(true)
    expect(job.estimate.inputTokens).toBeGreaterThan(1120)
    expect(t.provider.generateCalls.length).toBe(callsBefore)

    t.knowledge.approve(job.id)
    await t.knowledge.idle()
    const done = t.knowledge.jobs(t.session.id).find((j) => j.id === job.id)
    expect(done?.status).toBe('done')
    expect(done?.failures).toEqual([])
    expect(t.rechunked).toEqual([1])

    // The transcription was stored and is what search and extraction now see.
    const transcriptRequest = t.provider.generateCalls.find((r) => r.images?.length)
    expect(transcriptRequest?.prompt).toContain('0: The dot product u v')
    const extractS1 = t.provider.generateCalls.find((r) => r.prompt.includes('[page 1]'))
    expect(extractS1?.prompt).toContain('$u \\cdot v = u_1 v_1 + u_2 v_2$')

    const review = t.knowledge.review(unit1 ?? 0)
    const names = review.concepts.map((c) => c.name)
    expect(names.sort()).toEqual(['dot product', 'length', 'matrix', 'vector'])
    const dot = review.concepts.find((c) => c.name === 'dot product')
    expect(dot?.pages.map((p) => p.page)).toEqual([{ index: 2, label: '12' }, { index: 3, label: '13' }])
    const matrix = review.concepts.find((c) => c.name === 'matrix')
    expect(matrix?.prerequisites.map((p) => p.name)).toEqual(['vector'])
    expect(matrix?.unresolved).toEqual(['set theory'])

    // The dot product / length loop was broken: exactly one of the two links remains.
    const length = review.concepts.find((c) => c.name === 'length')
    const dotNeedsLength = dot?.prerequisites.some((p) => p.name === 'length') ?? false
    const lengthNeedsDot = length?.prerequisites.some((p) => p.name === 'dot product') ?? false
    expect(dotNeedsLength !== lengthNeedsDot).toBe(true)
    expect([...(dot?.removed ?? []), ...(length?.removed ?? [])].map((r) => r.status)).toEqual(['removed-cycle'])

    // Learning order puts every concept after its prerequisites.
    const order = review.concepts.map((c) => c.id)
    for (const c of review.concepts) for (const p of c.prerequisites) if (order.includes(p.id)) expect(order.indexOf(p.id)).toBeLessThan(order.indexOf(c.id))

    // Estimating again finds everything cached: nothing is paid for twice.
    const again = t.knowledge.estimateUnit(unit1 ?? 0)
    const parts = Object.fromEntries(again.estimate.parts.map((p) => [p.kind, p]))
    expect(parts['transcribe']).toMatchObject({ calls: 0, cached: 1 })
    expect(parts['extract']).toMatchObject({ calls: 0, cached: 2 })
    const callsAfterFirstRun = t.provider.generateCalls.length
    t.knowledge.approve(again.id)
    await t.knowledge.idle()
    expect(t.provider.generateCalls.length).toBe(callsAfterFirstRun)
    expect(t.knowledge.review(unit1 ?? 0).concepts).toHaveLength(4)
  })

  it('pauses on an exhausted quota and resumes after a restart without repeating any paid call', async () => {
    const db = openDatabase(':memory:')
    const first = setup(db)
    seedBook(db, first.session.id)
    const [unit1] = await confirmSyllabus(first)
    t_bothSections(db, unit1 ?? 0)
    const job = first.knowledge.estimateUnit(unit1 ?? 0)
    // The second extraction hits the daily quota.
    first.provider.respond = (request) => (request.prompt.includes('[page 3]') ? new ProviderError('daily', 'quota-daily') : answer(request))
    first.knowledge.approve(job.id)
    await first.knowledge.idle()
    const paused = first.knowledge.jobs(first.session.id).find((j) => j.id === job.id)
    expect(paused?.status).toBe('paused')
    expect(paused?.pauseReason).toMatch(/daily/)
    expect(paused?.resumeAt).not.toBeNull()
    await first.knowledge.stop()
    const paidBefore = first.provider.generateCalls.filter((r) => !r.prompt.includes('[page 3]')).map((r) => r.prompt)

    // A new app start on the same database.
    const second = setup(db)
    second.knowledge.start()
    second.knowledge.resume(job.id)
    await second.knowledge.idle()
    expect(second.knowledge.jobs(second.session.id).find((j) => j.id === job.id)?.status).toBe('done')
    const repeated = second.provider.generateCalls.filter((r) => paidBefore.includes(r.prompt))
    expect(repeated).toEqual([])
    expect(second.provider.generateCalls.some((r) => r.prompt.includes('[page 3]'))).toBe(true)
    await second.knowledge.stop()
  })

  it('continues a job that was running when the app stopped', async () => {
    const db = openDatabase(':memory:')
    const first = setup(db)
    seedBook(db, first.session.id)
    const [unit1] = await confirmSyllabus(first)
    const job = first.knowledge.estimateUnit(unit1 ?? 0)
    // Simulate a crash right after approval: the job is marked running but nothing ran.
    db.prepare("UPDATE knowledge_jobs SET status = 'running' WHERE id = ?").run(job.id)
    const second = setup(db)
    second.knowledge.start()
    await second.knowledge.idle()
    expect(second.knowledge.jobs(second.session.id).find((j) => j.id === job.id)?.status).toBe('done')
    await second.knowledge.stop()
  })

  it('marks a step failed after three malformed replies and still builds the graph', async () => {
    const t = setup()
    seedBook(t.db, t.session.id)
    const [unit1] = await confirmSyllabus(t)
    const job = t.knowledge.estimateUnit(unit1 ?? 0)
    t.provider.respond = (request) => (request.images?.length ? { text: '{"blocks":[{"fromLine":99,"text":"x"}]}' } : answer(request))
    t.knowledge.approve(job.id)
    await t.knowledge.idle()
    const done = t.knowledge.jobs(t.session.id).find((j) => j.id === job.id)
    expect(done?.status).toBe('done')
    expect(done?.failures).toHaveLength(1)
    expect(done?.failures[0]?.label).toMatch(/Transcribe page 12/)
    expect(t.provider.generateCalls.filter((r) => r.images?.length)).toHaveLength(3)
    expect(t.knowledge.review(unit1 ?? 0).concepts.length).toBeGreaterThan(0)
    expect(t.db.prepare('SELECT count(*) AS n FROM page_transcripts').get()).toEqual({ n: 0 })
  })

  it('refuses an estimate that does not fit under the call cap', async () => {
    const t = setup()
    seedBook(t.db, t.session.id)
    const [unit1] = await confirmSyllabus(t)
    t.sessions.setLimits(t.session.id, { callCap: 3, spendCapUsd: null })
    const job = t.knowledge.estimateUnit(unit1 ?? 0)
    expect(() => t.knowledge.approve(job.id)).toThrow(/cap of 3/)
  })
})

function t_bothSections(db: Database.Database, unitId: number): void {
  db.prepare('INSERT OR IGNORE INTO unit_sections (unit_id, section_id) SELECT ?, id FROM sections').run(unitId)
}

describe('review edits', () => {
  async function built() {
    const t = setup()
    seedBook(t.db, t.session.id)
    const [unit1] = await confirmSyllabus(t)
    t_bothSections(t.db, unit1 ?? 0)
    t.knowledge.approve(t.knowledge.estimateUnit(unit1 ?? 0).id)
    await t.knowledge.idle()
    const id = (name: string): number => t.knowledge.review(unit1 ?? 0).concepts.find((c) => c.name === name)?.id ?? -1
    return { t, unit: unit1 ?? 0, id }
  }

  it('renames, merges, deletes and relinks, refusing a loop', async () => {
    const { t, unit, id } = await built()
    let review = t.knowledge.renameConcept(unit, id('vector'), 'Vector', 'A quantity with size and direction.')
    expect(review.concepts.find((c) => c.name === 'Vector')?.edited).toBe(true)

    expect(() => t.knowledge.linkConcepts(unit, id('Vector'), id('matrix'))).toThrow(/already depends/)
    review = t.knowledge.unlinkConcepts(unit, id('matrix'), id('Vector'))
    expect(review.concepts.find((c) => c.name === 'matrix')?.removed.map((r) => r.status)).toEqual(['removed-user'])
    review = t.knowledge.linkConcepts(unit, id('Vector'), id('matrix'))
    expect(review.concepts.find((c) => c.name === 'Vector')?.prerequisites.map((p) => [p.name, p.source])).toEqual([['matrix', 'user']])

    const lengthPages = review.concepts.find((c) => c.name === 'length')?.pages.length ?? 0
    review = t.knowledge.mergeConcepts(unit, id('length'), id('dot product'))
    expect(review.concepts.map((c) => c.name)).not.toContain('length')
    const dot = review.concepts.find((c) => c.name === 'dot product')
    expect(dot?.pages.length).toBeGreaterThanOrEqual(lengthPages)
    expect(dot?.prerequisites.map((p) => p.name)).not.toContain('dot product')

    review = t.knowledge.deleteConcept(unit, id('matrix'))
    expect(review.concepts.map((c) => c.name).sort()).toEqual(['Vector', 'dot product'])
  })
})

describe('syllabus re-save', () => {
  /** A processed unit 1 with progress on one concept: a lesson, a graded answer, mastery, and a confirmed "I know this unit" check. */
  async function processedWithProgress(stripUnitIds: boolean) {
    const t = setup()
    seedBook(t.db, t.session.id)
    const [unit1, unit2] = await confirmSyllabus(t)
    t.knowledge.approve(t.knowledge.estimateUnit(unit1 ?? 0).id)
    await t.knowledge.idle()
    const sid = t.session.id
    const conceptId = t.knowledge.review(unit1 ?? 0).concepts[0]?.id ?? 0
    const run = (sql: string, ...args: unknown[]) => Number(t.db.prepare(sql).run(...args).lastInsertRowid)
    const questionId = run("INSERT INTO questions (session_id, concept_id, kind, ordinal, stem, prompt, prompt_version, cache_key) VALUES (?, ?, 'diagnostic', 0, 'q', 'p', 1, 'k')", sid, conceptId)
    const lessonId = run("INSERT INTO lessons (session_id, concept_id, step) VALUES (?, ?, 'guided')", sid, conceptId)
    const checkId = run("INSERT INTO diagnostics (session_id, kind, unit_id, status) VALUES (?, 'confirm', ?, 'done')", sid, unit1)
    const checkOn2 = run("INSERT INTO diagnostics (session_id, kind, unit_id, status) VALUES (?, 'confirm', ?, 'done')", sid, unit2)
    for (const d of [checkId, checkOn2]) {
      const a = run("INSERT INTO attempts (session_id, concept_id, question_id, diagnostic_id, shown_at, status) VALUES (?, ?, ?, ?, 'x', 'graded')", sid, conceptId, questionId, d)
      run("INSERT INTO grades (attempt_id, pass, verdict, score, reason, graded_by) VALUES (?, 1, 'correct', 1, 'r', 'local')", a)
      run("INSERT INTO mastery_events (session_id, concept_id, kind, attempt_id, p_before, p_after) VALUES (?, ?, 'diagnostic', ?, 0.2, 0.47)", sid, conceptId, a)
    }
    run("INSERT INTO unit_overrides (session_id, unit_id, claimed, diagnostic_id, outcome) VALUES (?, ?, 'known', ?, 'confirmed')", sid, unit1, checkId)
    run('INSERT INTO mastery (concept_id, session_id, p_known, evidence, mastered_at) VALUES (?, ?, 0.97, 3, ?)', conceptId, sid, '2026-11-14T10:00:00.000Z')
    if (stripUnitIds) {
      // As 0.1.0 stored it: the confirmed draft does not name its units.
      const row = t.db.prepare<[], { id: number; draft: string }>('SELECT id, draft FROM syllabi').get()
      const draft = JSON.parse(row?.draft ?? '{}') as SyllabusDraft
      for (const u of draft.units) delete u.unitId
      t.db.prepare('UPDATE syllabi SET draft = ? WHERE id = ?').run(JSON.stringify(draft), row?.id)
    }
    const count = (table: string) => t.db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n
    return { t, unit1: unit1 ?? 0, unit2: unit2 ?? 0, conceptId, lessonId, checkOn2, count }
  }

  for (const stripUnitIds of [false, true]) {
    it(`keeps a processed unit's concepts, job, checks and progress when the syllabus is edited and saved again${stripUnitIds ? ' (draft saved by 0.1.0)' : ''}`, async () => {
      const { t, unit1, unit2, conceptId, lessonId, checkOn2, count } = await processedWithProgress(stripUnitIds)
      const tables = ['concept_units', 'knowledge_jobs', 'job_steps', 'diagnostics', 'attempts', 'grades', 'mastery_events', 'mastery', 'lessons', 'unit_overrides']
      const before = Object.fromEntries(tables.map((x) => [x, count(x)]))
      const conceptsOfUnit1 = t.knowledge.review(unit1).concepts.map((c) => c.id)
      expect(conceptsOfUnit1.length).toBeGreaterThan(0)

      // Rename unit 1, give it a date, move a new unit in front of it, and keep unit 2.
      const state = t.knowledge.syllabusState(t.session.id)
      const draft = state?.draft as SyllabusDraft
      expect(draft.units.map((u) => u.unitId)).toEqual([unit1, unit2])
      const [u1, u2] = draft.units as [DraftUnit, DraftUnit]
      const units = t.knowledge.saveSyllabus(state?.id ?? 0, {
        units: [{ ...u1, unitId: null, title: 'Review week', tocKeys: [] }, { ...u1, title: 'Vectors and lengths', startDate: '2026-09-02' }, u2],
        exams: [{ title: 'Midterm', date: '2026-12-01', weight: 40, units: [1, 2] }]
      })

      expect(units.map((u) => [u.title, u.id === unit1, u.id === unit2])).toEqual([['Review week', false, false], ['Vectors and lengths', true, false], ['Matrices', false, true]])
      expect(units[1]?.conceptCount).toBe(conceptsOfUnit1.length)
      expect(units[1]?.lastJob?.status).toBe('done')
      expect(t.knowledge.review(unit1).concepts.map((c) => c.id)).toEqual(conceptsOfUnit1)
      for (const x of tables) expect([x, count(x)]).toEqual([x, before[x]])
      expect(t.db.prepare('SELECT unit_id FROM unit_overrides').pluck().get()).toBe(unit1)
      expect(t.db.prepare('SELECT mastered_at FROM mastery WHERE concept_id = ?').pluck().get(conceptId)).toBe('2026-11-14T10:00:00.000Z')
      expect(t.db.prepare('SELECT step FROM lessons WHERE id = ?').pluck().get(lessonId)).toBe('guided')
      expect(t.db.prepare('SELECT unit_id FROM exam_units ORDER BY unit_id').pluck().all()).toEqual([unit1, unit2])

      // Removing unit 2 removes only that unit; its confirming check and the answers in it stay.
      const again = t.knowledge.syllabusState(t.session.id)?.draft as SyllabusDraft
      expect(again.units.map((u) => u.unitId)).toEqual(units.map((u) => u.id))
      t.knowledge.saveSyllabus(state?.id ?? 0, { units: again.units.slice(0, 2), exams: [] })
      expect(t.knowledge.units(t.session.id).map((u) => u.title)).toEqual(['Review week', 'Vectors and lengths'])
      expect(t.db.prepare('SELECT unit_id FROM diagnostics WHERE id = ?').pluck().get(checkOn2)).toBeNull()
      expect([count('attempts'), count('grades'), count('mastery_events')]).toEqual([before['attempts'], before['grades'], before['mastery_events']])
      expect(t.knowledge.review(unit1).concepts.map((c) => c.id)).toEqual(conceptsOfUnit1)
    })
  }
})

describe('exam editing', () => {
  it('changes an exam\'s date and weight in place, in the saved syllabus too, without touching units', async () => {
    const t = setup()
    seedBook(t.db, t.session.id)
    const units = await confirmSyllabus(t)
    const [exam] = t.knowledge.exams(t.session.id)
    expect(exam).toMatchObject({ title: 'Midterm', date: '2026-10-15', weight: 30 })
    expect(exam?.units.map((u) => u.id)).toEqual(units)
    const after = t.knowledge.updateExam(t.session.id, exam?.id ?? 0, '2026-11-20', 40)
    expect(after[0]).toMatchObject({ id: exam?.id, date: '2026-11-20', weight: 40 })
    expect(t.knowledge.units(t.session.id).map((u) => u.id)).toEqual(units)
    expect(t.knowledge.syllabusState(t.session.id)?.draft?.exams[0]).toMatchObject({ date: '2026-11-20', weight: 40 })
    expect(() => t.knowledge.updateExam(t.session.id, exam?.id ?? 0, '20 Nov', null)).toThrow(/date/)
    expect(() => t.knowledge.updateExam(t.session.id, 999, null, null)).toThrow(/not part/)
  })
})
