// The tutor test fixture: a four-page book, a course over it, and a fake model that answers every
// tutor request like a well-behaved model would. Shared by the tutor, review and simulation tests.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { ExamInfo } from '../../src/shared/knowledge'
import type { ReviewStreamEvent, SittingView } from '../../src/shared/reviews'
import type { LessonView, StreamEvent } from '../../src/shared/tutor'
import { chunkSection } from '../../src/main/ingestion/chunker'
import { IngestionReader } from '../../src/main/ingestion/reader'
import { IngestionRepo } from '../../src/main/ingestion/repo'
import { searchPassages } from '../../src/main/ingestion/search'
import type { TextLine } from '../../src/main/ingestion/types'
import { KnowledgeService, PromptLibrary } from '../../src/main/knowledge'
import { ProviderService, UsageStore, type GenerateRequest } from '../../src/main/providers'
import { openDatabase, SessionStore, SettingsStore } from '../../src/main/storage'
import { TutorService } from '../../src/main/tutor'
import { FakeAppClock, FakeClock } from './fakes/fakeClock'
import { FakeEncryptor, FakeProvider, type FakeAnswer } from './fakes/fakeProvider'

const PROMPTS = join(import.meta.dirname, '..', '..', 'prompts')
const line = (text: string, y: number): TextLine => ({ text, x: 72, y, size: 10, bold: false })

/** A four-page book, one concept per page, printed page numbers 11 to 14. */
export function seedBook(db: Database.Database, sessionId: number): { repo: IngestionRepo; materialId: number } {
  const repo = new IngestionRepo(db)
  const materialId = repo.insertMaterial({ sessionId, sha256: 'book-sha', originalName: 'book.pdf', storedName: 'book-sha.pdf', kind: 'pdf', byteSize: 1 })
  repo.startMaterial(materialId, 4, 'outline')
  const pages = ['A relation is a set of ordered pairs.', 'A function is a relation with one output per input.', 'The domain of a function is its set of inputs.', 'A vector has a length and a direction.']
  pages.forEach((text, i) => {
    repo.insertPage({
      sessionId, materialId, pageIndex: i + 1, pageLabel: String(i + 11), status: 'done', method: 'text',
      lines: [line(text, 100)], height: 792, scanned: false, mathHeavy: false, figureHeavy: false, ocrConfidence: null, error: null
    })
  })
  const sections = [1, 2, 3, 4].map((p) => ({ chapter: '1 Basics', section: `1.${p} Part ${p}`, startPage: p, startY: 0 }))
  sections.forEach((s, i) => {
    const next = sections[i + 1] ?? null
    repo.insertSectionWithChunks({ sessionId, materialId }, i, s, 'outline', chunkSection(repo.loadPages(materialId, s.startPage, next ? next.startPage : 4), s, next, 10))
  })
  return { repo, materialId }
}

/** Unit 1 has relation -> function -> domain, and vector on its own. Unit 2 is not processed. */
export function seedCourse(db: Database.Database, sessionId: number, materialId: number): { unit1: number; unit2: number; ids: Record<string, number> } {
  const syllabusId = Number(db.prepare("INSERT INTO syllabi (session_id, source_name, sha256, text, status) VALUES (?, 's', 's', 's', 'confirmed')").run(sessionId).lastInsertRowid)
  const unit = (ordinal: number, title: string) => Number(db.prepare('INSERT INTO units (session_id, syllabus_id, ordinal, title) VALUES (?, ?, ?, ?)').run(sessionId, syllabusId, ordinal, title).lastInsertRowid)
  const unit1 = unit(0, 'Functions')
  const unit2 = unit(1, 'Matrices')
  const ids: Record<string, number> = {}
  ;[['relation', 1], ['function', 2], ['domain', 3], ['vector', 4]].forEach(([name, page]) => {
    const id = Number(db.prepare('INSERT INTO concepts (session_id, name, definition, first_material_id, first_page) VALUES (?, ?, ?, ?, ?)').run(sessionId, name, `The ${name}.`, materialId, page).lastInsertRowid)
    db.prepare('INSERT INTO concept_units (concept_id, unit_id) VALUES (?, ?)').run(id, unit1)
    db.prepare('INSERT INTO concept_pages (concept_id, material_id, page_index) VALUES (?, ?, ?)').run(id, materialId, page)
    ids[name as string] = id
  })
  const link = (c: string, p: string) => db.prepare("INSERT INTO concept_prereqs (concept_id, prereq_id, source, status) VALUES (?, ?, 'extracted', 'active')").run(ids[c], ids[p])
  link('function', 'relation')
  link('domain', 'function')
  return { unit1, unit2, ids }
}

export const reply = (value: unknown): FakeAnswer => ({ text: JSON.stringify(value), inputTokens: 800, outputTokens: 200 })
const firstCite = (prompt: string): string => /\[(S\d+ p\. [^\]]+)\]/.exec(prompt)?.[1] ?? 'S1 p. 11'

/**
 * Answers like a well-behaved model. Grades: an answer containing RIGHT meets every criterion, HALF
 * only the first. Reasoning containing FLAWED is judged flawed, NOTHING none, anything else sound.
 */
export function answer(request: GenerateRequest): FakeAnswer {
  const keys = Object.keys((request.jsonSchema?.['properties'] ?? {}) as object)
  const cite = firstCite(request.prompt)
  if (!request.jsonSchema && request.system?.includes('re-teach')) return { text: `You missed the key step. The domain is the set of inputs [${cite}]. So the answer is all $x$ with $x$ at least 0.`, outputTokens: 120 }
  if (request.system?.includes('You write review questions')) {
    const concept = /^Concept: (.*)$/m.exec(request.prompt)?.[1] ?? '?'
    const n = (request.prompt.match(/^- /gm) ?? []).length
    const q = (i: number) => ({
      stem: `review variant ${n + i} about ${concept}`,
      referenceAnswer: 'Reference.',
      criteria: [
        { id: 'c1', text: 'States the result', points: 2, essential: true },
        { id: 'c2', text: 'Gives the reason', points: 2, essential: true }
      ],
      hint: 'Think about the inputs.',
      pages: [cite]
    })
    return reply({ covered: true, questions: [q(1), q(2), q(3)] })
  }
  if (!request.jsonSchema) return { text: `## Explanation\nA domain is the set of inputs [${cite}].\n\n## Worked example\nFor $f(x) = \\sqrt{x}$ the domain is $x \\ge 0$.`, outputTokens: 300 }
  if (keys.includes('covered')) {
    const q = (kind: string, n = 0) => ({
      kind,
      stem: `${kind} question ${n} about the concept`,
      referenceAnswer: 'Reference.',
      scaffold: kind === 'guided' || kind === 'partial' ? 'Step 1: ___' : null,
      criteria: [
        { id: 'c1', text: 'States the result', points: 2, essential: true },
        { id: 'c2', text: 'Gives the reason', points: 2, essential: true }
      ],
      pages: [cite]
    })
    const more = request.prompt.includes('Write only three new')
    return reply({ covered: true, questions: more ? [q('unaided', 4), q('unaided', 5), q('unaided', 6)] : [q('opening'), q('guided'), q('partial'), q('unaided', 1), q('unaided', 2), q('unaided', 3)] })
  }
  if (keys.includes('questions')) {
    const concepts = [...request.prompt.matchAll(/^(C\d+): /gm)].map((m) => m[1] as string)
    return reply({
      questions: concepts.flatMap((concept) =>
        (['probe', 'confirm'] as const).map((purpose) => ({ concept, purpose, stem: `${purpose} ${concept}?`, choices: ['w', 'right', 'x', 'y'], answer: 1, why: 'Because.', pages: [cite] }))
      )
    })
  }
  const studentAnswer = request.prompt.split("Student's answer:\n")[1]?.split('\n\n')[0] ?? ''
  const met = studentAnswer.includes('RIGHT') ? ['yes', 'yes'] : studentAnswer.includes('HALF') ? ['yes', 'no'] : ['no', 'no']
  const reasoningText = request.prompt.split("Student's reasoning (typed or dictated):\n")[1]?.split('\n\n')[0]
  const judged =
    reasoningText === undefined
      ? {}
      : { reasoning: reasoningText.includes('FLAWED') ? { judgment: 'flawed', comment: 'You used the wrong rule in step 2.' } : reasoningText.includes('NOTHING') ? { judgment: 'none', comment: '' } : { judgment: 'sound', comment: 'Each step follows.' } }
  const grade = { criteria: [{ id: 'c1', met: met[0], evidence: '' }, { id: 'c2', met: met[1], evidence: '' }], reason: 'Graded.', feedback: '', pages: [cite], outsideSources: false, ...judged }
  if (keys.includes('assessment')) {
    const holds = request.prompt.includes('VALID OBJECTION')
    return reply({ ...grade, criteria: holds ? [{ id: 'c1', met: 'yes', evidence: '' }, { id: 'c2', met: 'yes', evidence: '' }] : grade.criteria, assessment: holds ? 'It holds.' : 'It does not hold.', changed: holds })
  }
  return reply(grade)
}

export interface SetupOptions {
  clock?: FakeAppClock
  exams?: (sessionId: number) => ExamInfo[]
  online?: { value: boolean }
}

export interface Harness {
  db: Database.Database
  session: ReturnType<SessionStore['current']>
  sessions: SessionStore
  provider: FakeProvider
  providers: ProviderService
  lessons: LessonView[]
  streamed: StreamEvent[]
  sittings: SittingView[]
  reviewStream: ReviewStreamEvent[]
  clock: FakeAppClock
  online: { value: boolean }
  make: () => TutorService
  tutor: TutorService
  setConsent: (v: boolean) => void
}

export type SeededHarness = Harness & ReturnType<typeof seedCourse>

export function setup(db: Database.Database = openDatabase(':memory:'), provider = new FakeProvider(), opts: SetupOptions = {}): Harness {
  const sessions = new SessionStore(db)
  const session = sessions.current()
  sessions.setLimits(session.id, { callCap: null, spendCapUsd: null })
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
  const prompts = new PromptLibrary((name) => readFileSync(join(PROMPTS, `${name}.txt`), 'utf8').trim())
  const ingestionRepo = new IngestionRepo(db)
  const reader = new IngestionReader(ingestionRepo)
  const knowledge = new KnowledgeService({
    db,
    providers,
    ingestion: { reader, readText: async () => ({ name: '', sha256: '', text: '' }), renderForVision: async () => new Uint8Array(), rechunkSections: async () => ({ chunks: 0 }), embedTexts: async () => [] },
    prompts,
    settings,
    limits: (id) => sessions.limits(id),
    onJob: () => undefined,
    onUsage: () => undefined
  })
  const lessons: LessonView[] = []
  const streamed: StreamEvent[] = []
  const sittings: SittingView[] = []
  const reviewStream: ReviewStreamEvent[] = []
  const clock = opts.clock ?? new FakeAppClock()
  const online = opts.online ?? { value: true }
  let consent = true
  const make = () =>
    new TutorService({
      db,
      providers,
      unitGraphs: (id) => knowledge.unitGraphs(id),
      retrieval: { reader, search: (id, q) => searchPassages(ingestionRepo, id, q, null) },
      prompts,
      consentGiven: () => consent,
      onLesson: (v) => lessons.push(v),
      onStream: (e) => streamed.push(e),
      onUsage: () => undefined,
      clock,
      settings,
      ...(opts.exams ? { exams: opts.exams } : {}),
      isOnline: () => online.value,
      onSitting: (v) => sittings.push(v),
      onReviewStream: (e) => reviewStream.push(e)
    })
  return {
    db,
    session,
    sessions,
    provider,
    providers,
    lessons,
    streamed,
    sittings,
    reviewStream,
    clock,
    online,
    make,
    tutor: make(),
    setConsent: (v: boolean) => {
      consent = v
    }
  }
}

export function seeded(opts: SetupOptions = {}): SeededHarness {
  const t = setup(undefined, undefined, opts)
  const { materialId } = seedBook(t.db, t.session.id)
  return { ...t, ...seedCourse(t.db, t.session.id, materialId) }
}

export const calls = (p: FakeProvider) => p.generateCalls.length
