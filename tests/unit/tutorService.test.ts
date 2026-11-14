import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { LessonView, StreamEvent } from '../../src/shared/tutor'
import { chunkSection } from '../../src/main/ingestion/chunker'
import { IngestionReader } from '../../src/main/ingestion/reader'
import { IngestionRepo } from '../../src/main/ingestion/repo'
import { searchPassages } from '../../src/main/ingestion/search'
import type { TextLine } from '../../src/main/ingestion/types'
import { KnowledgeService, PromptLibrary } from '../../src/main/knowledge'
import { MASTERY } from '../../src/main/learner'
import { ProviderError, ProviderService, UsageStore, type GenerateRequest } from '../../src/main/providers'
import { openDatabase, SessionStore, SettingsStore } from '../../src/main/storage'
import { TutorService } from '../../src/main/tutor'
import { FakeClock } from './fakes/fakeClock'
import { FakeEncryptor, FakeProvider, type FakeAnswer } from './fakes/fakeProvider'

const PROMPTS = join(import.meta.dirname, '..', '..', 'prompts')
const line = (text: string, y: number): TextLine => ({ text, x: 72, y, size: 10, bold: false })

/** A four-page book, one concept per page, printed page numbers 11 to 14. */
function seedBook(db: Database.Database, sessionId: number): { repo: IngestionRepo; materialId: number } {
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
function seedCourse(db: Database.Database, sessionId: number, materialId: number): { unit1: number; unit2: number; ids: Record<string, number> } {
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

const reply = (value: unknown): FakeAnswer => ({ text: JSON.stringify(value), inputTokens: 800, outputTokens: 200 })
const firstCite = (prompt: string): string => /\[(S\d+ p\. [^\]]+)\]/.exec(prompt)?.[1] ?? 'S1 p. 11'

/**
 * Answers like a well-behaved model. Grades: an answer containing RIGHT meets every criterion, HALF
 * only the first. Reasoning containing FLAWED is judged flawed, NOTHING none, anything else sound.
 */
function answer(request: GenerateRequest): FakeAnswer {
  const keys = Object.keys((request.jsonSchema?.['properties'] ?? {}) as object)
  const cite = firstCite(request.prompt)
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

function setup(db = openDatabase(':memory:'), provider = new FakeProvider()) {
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
      onUsage: () => undefined
    })
  return { db, session, sessions, provider, providers, lessons, streamed, make, tutor: make(), setConsent: (v: boolean) => (consent = v) }
}

function seeded() {
  const t = setup()
  const { materialId } = seedBook(t.db, t.session.id)
  return { ...t, ...seedCourse(t.db, t.session.id, materialId) }
}

const calls = (p: FakeProvider) => p.generateCalls.length

describe('diagnostic', () => {
  it('writes all questions in one call, starts from prerequisites and stops a branch after a miss', async () => {
    const t = seeded()
    let state = await t.tutor.startDiagnostic(t.session.id)
    expect(calls(t.provider)).toBe(1)
    expect(t.tutor.repo.questionsOf(t.ids['relation'] as number, 'diagnostic')).toHaveLength(2)
    // relation decides the most (function and domain depend on it).
    expect(state.question?.conceptName).toBe('relation')
    state = t.tutor.answerDiagnostic(state.id, state.question?.questionId ?? 0, 1)
    expect(state.question?.conceptName).toBe('function')
    // Miss: domain is not asked; vector is.
    state = t.tutor.answerDiagnostic(state.id, state.question?.questionId ?? 0, null)
    expect(state.question?.conceptName).toBe('vector')
    state = t.tutor.answerDiagnostic(state.id, state.question?.questionId ?? 0, 0)
    expect(state.status).toBe('done')
    expect(state.results.map((r) => [r.conceptName, r.chosen])).toEqual([['relation', 1], ['function', null], ['vector', 0]])
    expect(calls(t.provider)).toBe(1)

    const m = t.tutor.learner.many(Object.values(t.ids))
    expect(m.get(t.ids['relation'] as number)?.p).toBeCloseTo(0.474, 3)
    expect(m.get(t.ids['domain'] as number)?.band).toBe('new')
    expect(m.get(t.ids['vector'] as number)?.band).toBe('new')

    const path = t.tutor.path(t.session.id)
    expect(path.diagnostic.status).toBe('done')
    expect(path.units.map((u) => [u.title, u.standing])).toEqual([['Functions', 'new'], ['Matrices', 'not-assessed']])
    // relation is not mastered, so function and domain are locked; relation comes first.
    expect(path.next?.name).toBe('relation')
    // Before the lesson starts: questions, explanation and four grades.
    expect(path.next?.estimate.calls).toBe(6)
    expect(path.units[0]?.concepts.find((c) => c.name === 'domain')?.waitingFor).toEqual(['function'])

    // A second diagnostic reuses the stored questions.
    await t.tutor.startDiagnostic(t.session.id)
    expect(calls(t.provider)).toBe(1)
  })

  it('refuses an answer to a question that is not the current one, and needs consent and a processed unit', async () => {
    const t = seeded()
    t.setConsent(false)
    await expect(t.tutor.startDiagnostic(t.session.id)).rejects.toThrow('Confirm the notice')
    t.setConsent(true)
    const state = await t.tutor.startDiagnostic(t.session.id)
    const q = state.question?.questionId ?? 0
    t.tutor.answerDiagnostic(state.id, q, 1)
    expect(() => t.tutor.answerDiagnostic(state.id, q, 1)).toThrow('already answered')
    const empty = setup()
    await expect(empty.tutor.startDiagnostic(empty.session.id)).rejects.toThrow('Process a unit first')
  })
})

describe('standing overrides', () => {
  it('confirms "I know this unit" with a check on its most advanced concepts, without new calls once questions exist', async () => {
    const t = seeded()
    await t.tutor.startDiagnostic(t.session.id)
    const before = calls(t.provider)
    let state = await t.tutor.claimUnitKnown(t.session.id, t.unit1)
    expect(calls(t.provider)).toBe(before)
    expect(state.kind).toBe('confirm')
    // The confirm questions, not the probes.
    expect(state.question?.stem).toMatch(/^confirm/)
    for (let i = 0; i < 3; i++) state = t.tutor.answerDiagnostic(state.id, state.question?.questionId ?? 0, i === 0 ? 0 : 1)
    expect(state).toMatchObject({ status: 'done', outcome: 'confirmed' })
    const path = t.tutor.path(t.session.id)
    expect(path.units[0]?.standing).toBe('known')
    expect(path.units[0]?.override).toEqual({ claimed: 'known', outcome: 'confirmed' })
    // Confirmed knowledge is not mastery: each concept still needs its lesson.
    expect(path.units[0]?.concepts.every((c) => c.mastery.p >= MASTERY.overrideKnown && !c.mastery.mastered)).toBe(true)
  })

  it('does not confirm when the check goes badly, and accepts "treat as new" without a check', async () => {
    const t = seeded()
    let state = await t.tutor.claimUnitKnown(t.session.id, t.unit1)
    for (let i = 0; i < 3; i++) state = t.tutor.answerDiagnostic(state.id, state.question?.questionId ?? 0, null)
    expect(state.outcome).toBe('not-confirmed')
    const path = t.tutor.markUnitNew(t.session.id, t.unit1)
    expect(path.units[0]?.standing).toBe('new')
    expect(path.units[0]?.override).toEqual({ claimed: 'new', outcome: 'accepted' })
    expect(() => t.tutor.markUnitNew(t.session.id, t.unit2)).toThrow('no concepts')
  })
})

/** Answers the current question, waits for its grade, and returns the graded view. */
async function answerAndWait(t: ReturnType<typeof seeded>, view: LessonView, text: string): Promise<LessonView> {
  t.tutor.answer(view.lessonId, view.question?.id ?? 0, text, false)
  await t.tutor.idle()
  return t.tutor.view(view.lessonId)
}

describe('lesson', () => {
  it('asks first, streams a cited explanation, fades support, grades with reasons and masters the concept', async () => {
    const t = seeded()
    const relation = t.ids['relation'] as number
    await expect(t.tutor.openLesson(t.session.id, t.ids['domain'] as number)).rejects.toThrow('Learn function first')

    let view = await t.tutor.openLesson(t.session.id, relation)
    expect(calls(t.provider)).toBe(1)
    expect(view.step).toBe('opening')
    expect(view.question?.kind).toBe('opening')
    expect(view.sources[0]?.pages[0]).toEqual({ index: 1, label: '11' })
    expect(view.estimate.calls).toBe(5)

    view = await answerAndWait(t, view, 'HALF an answer')
    expect(view.attempt?.grades[0]).toMatchObject({ verdict: 'partial', reason: 'Graded.', pages: ['S1 p. 11'] })
    expect(view.attempt?.grades[0]?.criteria.map((c) => [c.text, c.met])).toEqual([['States the result', 'yes'], ['Gives the reason', 'no']])
    expect(view.canFastTrack).toBe(false)

    view = t.tutor.continue(view.lessonId)
    expect(view.step).toBe('explain')
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
    const text = t.streamed.filter((e) => e.kind === 'text').map((e) => e.text).join('')
    expect(t.streamed.filter((e) => e.kind === 'text').length).toBeGreaterThan(3)
    expect(view.explanation?.markdown).toBe(text.trim())
    expect(view.explanation?.markdown).toContain('[S1 p. 11]')

    view = t.tutor.continue(view.lessonId)
    expect(view.question).toMatchObject({ kind: 'guided', scaffold: 'Step 1: ___' })
    view = await answerAndWait(t, t.tutor.continue((await answerAndWait(t, view, 'RIGHT')).lessonId), 'RIGHT')
    expect(view.question?.kind).toBe('partial')
    view = t.tutor.continue(view.lessonId)
    expect(view.question).toMatchObject({ kind: 'unaided', number: 1, scaffold: null })
    view = await answerAndWait(t, view, 'RIGHT')
    expect(view.mastery.mastered).toBe(true)
    view = t.tutor.continue(view.lessonId)
    expect(view.step).toBe('done')
    expect(view.next?.name).toBe('function')
    expect(t.tutor.path(t.session.id).units[0]?.concepts.find((c) => c.name === 'function')?.locked).toBe(false)
    // Questions 1, explanation 1, grades 4.
    expect(calls(t.provider)).toBe(6)
  })

  it('saves the answer before grading starts, and keeps it when grading fails', async () => {
    const t = seeded()
    let view = await t.tutor.openLesson(t.session.id, t.ids['relation'] as number)
    t.provider.respond = (request) => {
      const saved = t.db.prepare("SELECT answer_text AS a, status FROM attempts WHERE lesson_id = ?").get(view.lessonId) as { a: string; status: string } | undefined
      expect(saved).toEqual({ a: 'my answer RIGHT', status: 'saved' })
      void request
      return new ProviderError('The key was rejected.', 'auth')
    }
    view = t.tutor.answer(view.lessonId, view.question?.id ?? 0, 'my answer RIGHT', false)
    expect(view.attempt).toMatchObject({ status: 'saved', answer: 'my answer RIGHT' })
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
    expect(view.attempt?.status).toBe('saved')
    expect(view.blocked).toMatchObject({ kind: 'error' })
    expect(() => t.tutor.continue(view.lessonId)).toThrow('graded before the lesson moves on')

    t.provider.respond = answer
    await t.tutor.retry(view.lessonId)
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
    expect(view.attempt?.grades[0]?.verdict).toBe('correct')
    expect(view.blocked).toBeNull()
  })

  it('after a crash between the reply and storing it, grades from the cache without paying again', async () => {
    const t = seeded()
    let view = await t.tutor.openLesson(t.session.id, t.ids['relation'] as number)
    const original = t.tutor.learner.addEvidence.bind(t.tutor.learner)
    let crash = true
    t.tutor.learner.addEvidence = (...args) => {
      if (crash) {
        crash = false
        throw new Error('Power cut.')
      }
      return original(...args)
    }
    view = t.tutor.answer(view.lessonId, view.question?.id ?? 0, 'RIGHT', false)
    await t.tutor.idle()
    expect(t.tutor.view(view.lessonId).attempt?.status).toBe('saved')
    const billed = t.providers.usageSummary(t.session.id).calls

    // The app starts again: a new service on the same database.
    const again = t.make()
    view = await again.openLesson(t.session.id, t.ids['relation'] as number)
    await again.idle()
    view = again.view(view.lessonId)
    expect(view.attempt?.grades[0]?.verdict).toBe('correct')
    expect(t.providers.usageSummary(t.session.id)).toMatchObject({ calls: billed, cacheHits: 1 })
  })

  it('reopens at the same step with the draft, and reuses stored questions and explanation', async () => {
    const t = seeded()
    let view = await t.tutor.openLesson(t.session.id, t.ids['relation'] as number)
    view = await answerAndWait(t, view, 'HALF')
    view = t.tutor.continue(view.lessonId)
    await t.tutor.idle()
    view = t.tutor.continue(view.lessonId)
    t.tutor.saveDraft(view.lessonId, 'answer', 'half-typed answer')
    const before = calls(t.provider)

    const again = t.make()
    expect(t.tutor.path(t.session.id).openLesson).toMatchObject({ name: 'relation', step: 'guided' })
    const reopened = await again.currentLesson(t.session.id)
    expect(reopened).toMatchObject({ step: 'guided', draft: 'half-typed answer' })
    expect(reopened?.question?.kind).toBe('guided')
    expect(reopened?.explanation?.markdown).toContain('## Worked example')
    await again.openLesson(t.session.id, t.ids['relation'] as number)
    expect(calls(t.provider)).toBe(before)
  })

  it('grades "I don\'t know" here, and offers the fast track only when mastery is high after the opening question', async () => {
    const t = seeded()
    const relation = t.ids['relation'] as number
    let view = await t.tutor.openLesson(t.session.id, relation)
    view = t.tutor.answer(view.lessonId, view.question?.id ?? 0, '', true)
    expect(view.attempt?.grades[0]).toMatchObject({ verdict: 'incorrect', gradedBy: 'local' })
    expect(view.attempt?.canContest).toBe(false)
    expect(calls(t.provider)).toBe(1)

    const s = seeded()
    s.tutor.learner.addEvidence(s.session.id, s.ids['relation'] as number, 'override-known', { value: 0.9 })
    let fast = await s.tutor.openLesson(s.session.id, s.ids['relation'] as number)
    fast = await answerAndWait(s, fast, 'RIGHT')
    expect(fast.canFastTrack).toBe(true)
    // Above the mastery threshold, but not mastered without an unaided answer.
    expect(fast.mastery.p).toBeGreaterThan(MASTERY.mastered)
    expect(fast.mastery.mastered).toBe(false)
    fast = s.tutor.continue(fast.lessonId, true)
    expect(fast.question?.kind).toBe('unaided')
    fast = await answerAndWait(s, fast, 'RIGHT')
    expect(fast.mastery.mastered).toBe(true)
  })

  it('writes more unaided questions when all are answered and the concept is not mastered', async () => {
    const t = seeded()
    let view = await t.tutor.openLesson(t.session.id, t.ids['relation'] as number)
    view = await answerAndWait(t, view, 'wrong')
    view = t.tutor.continue(view.lessonId)
    await t.tutor.idle()
    view = t.tutor.continue(view.lessonId)
    for (let i = 0; i < 5; i++) {
      view = await answerAndWait(t, view, 'wrong')
      if (i < 4) view = t.tutor.continue(view.lessonId)
    }
    expect(view.canMoreQuestions).toBe(true)
    expect(() => t.tutor.continue(view.lessonId)).toThrow('Ask for more questions')
    view = await t.tutor.moreQuestions(view.lessonId)
    expect(view.question).toMatchObject({ kind: 'unaided', number: 4 })
  })
})

describe('reasoning', () => {
  const promptsOf = (p: FakeProvider) => p.generateCalls.map((c) => c.prompt)

  it('saves the reasoning with the answer before grading, grades both with the reasoning prompt and shows the judgment', async () => {
    const t = seeded()
    let view = await t.tutor.openLesson(t.session.id, t.ids['relation'] as number)
    t.provider.respond = (request) => {
      const saved = t.db.prepare('SELECT answer_text AS a, reasoning_text AS r, status FROM attempts WHERE lesson_id = ?').get(view.lessonId)
      expect(saved).toEqual({ a: 'RIGHT', r: 'um so the the input one goes to two outputs', status: 'saved' })
      return answer(request)
    }
    view = t.tutor.answer(view.lessonId, view.question?.id ?? 0, 'RIGHT', false, '  um so the the input one goes to two outputs ')
    expect(view.attempt).toMatchObject({ status: 'saved', reasoning: 'um so the the input one goes to two outputs' })
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
    expect(view.attempt?.grades[0]).toMatchObject({ verdict: 'correct', reasoning: { judgment: 'sound', comment: 'Each step follows.' } })
    const sent = promptsOf(t.provider).at(-1) ?? ''
    expect(sent).toContain("Student's reasoning (typed or dictated):\num so the the input one goes to two outputs")
    expect(t.provider.generateCalls.at(-1)?.system).toContain('dictation')
  })

  it('without reasoning, grades exactly as before: the old prompt and no judgment', async () => {
    const t = seeded()
    let view = await t.tutor.openLesson(t.session.id, t.ids['relation'] as number)
    view = await answerAndWait(t, view, 'RIGHT')
    expect(view.attempt).toMatchObject({ reasoning: '' })
    expect(view.attempt?.grades[0]).toMatchObject({ verdict: 'correct', reasoning: null })
    expect(promptsOf(t.provider).at(-1)).not.toContain("Student's reasoning")
  })

  it('makes a right answer with flawed reasoning partly correct, so it never masters the concept', async () => {
    const t = seeded()
    const relation = t.ids['relation'] as number
    t.tutor.learner.addEvidence(t.session.id, relation, 'override-known', { value: 0.9 })
    let view = await t.tutor.openLesson(t.session.id, relation)
    view = await answerAndWait(t, view, 'RIGHT')
    view = t.tutor.continue(view.lessonId, true)
    expect(view.question?.kind).toBe('unaided')
    t.tutor.answer(view.lessonId, view.question?.id ?? 0, 'RIGHT', false, 'FLAWED: I divided both sides by x')
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
    expect(view.attempt?.grades[0]).toMatchObject({ verdict: 'partial', score: 1, reasoning: { judgment: 'flawed', comment: 'You used the wrong rule in step 2.' } })
    expect(view.mastery.mastered).toBe(false)
  })

  it('keeps both drafts across a restart and clears them when the answer is submitted', async () => {
    const t = seeded()
    let view = await t.tutor.openLesson(t.session.id, t.ids['relation'] as number)
    t.tutor.saveDraft(view.lessonId, 'answer', 'half an answer')
    t.tutor.saveDraft(view.lessonId, 'reasoning', 'first I looked at the inputs')
    expect(await t.make().currentLesson(t.session.id)).toMatchObject({ draft: 'half an answer', draftReasoning: 'first I looked at the inputs' })
    view = t.tutor.answer(view.lessonId, view.question?.id ?? 0, 'RIGHT', false, 'first I looked at the inputs')
    expect(view).toMatchObject({ draft: '', draftReasoning: '' })
    await t.tutor.idle()
  })

  it('sends a contest of an answer with reasoning to the reasoning contest prompt, with the first judgment', async () => {
    const t = seeded()
    let view = await t.tutor.openLesson(t.session.id, t.ids['relation'] as number)
    t.tutor.answer(view.lessonId, view.question?.id ?? 0, 'HALF', false, 'FLAWED reasoning')
    await t.tutor.idle()
    view = t.tutor.contest(t.tutor.view(view.lessonId).attempt?.id ?? 0, 'VALID OBJECTION: my reasoning says why.')
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
    const sent = promptsOf(t.provider).at(-1) ?? ''
    expect(sent).toContain('Reasoning: flawed (You used the wrong rule in step 2.)')
    expect(sent).toContain("Student's reasoning (typed or dictated):\nFLAWED reasoning")
    // The second grade meets every criterion but still judges the reasoning flawed: partly correct.
    expect(view.attempt?.grades.map((g) => g.verdict)).toEqual(['partial', 'partial'])
  })

  it('refuses reasoning that is too long', async () => {
    const t = seeded()
    const view = await t.tutor.openLesson(t.session.id, t.ids['relation'] as number)
    expect(() => t.tutor.answer(view.lessonId, view.question?.id ?? 0, 'RIGHT', false, 'x'.repeat(5001))).toThrow('Keep your thinking under')
  })
})

describe('contest', () => {
  it('runs a second grading that sees the objection, keeps both grades, allows one contest and updates mastery', async () => {
    const t = seeded()
    let view = await t.tutor.openLesson(t.session.id, t.ids['relation'] as number)
    view = await answerAndWait(t, view, 'HALF')
    const attemptId = view.attempt?.id ?? 0
    const before = view.mastery.p
    view = t.tutor.contest(attemptId, 'VALID OBJECTION: I gave the reason in the second sentence.')
    expect(view.attempt?.contestPending).toBe(true)
    expect(t.db.prepare('SELECT objection FROM attempts WHERE id = ?').pluck().get(attemptId)).toContain('VALID OBJECTION')
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
    expect(view.attempt?.grades.map((g) => [g.pass, g.verdict])).toEqual([[1, 'partial'], [2, 'correct']])
    expect(view.attempt?.grades[1]).toMatchObject({ assessment: 'It holds.', objection: 'VALID OBJECTION: I gave the reason in the second sentence.' })
    expect(view.attempt?.canContest).toBe(false)
    expect(view.mastery.p).toBeGreaterThan(before)
    expect(() => t.tutor.contest(attemptId, 'Again!')).toThrow('only once')
    expect(t.tutor.learner.history(t.ids['relation'] as number).map((h) => h.kind)).toEqual(['answer', 'regrade'])
  })

  it('keeps the grade when the objection does not hold', async () => {
    const t = seeded()
    let view = await t.tutor.openLesson(t.session.id, t.ids['relation'] as number)
    view = await answerAndWait(t, view, 'HALF')
    t.tutor.contest(view.attempt?.id ?? 0, 'I am certain this is completely right.')
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
    expect(view.attempt?.grades.map((g) => g.verdict)).toEqual(['partial', 'partial'])
  })
})

describe('call cap', () => {
  it('stops at the cap with the answer saved, and grades it once the cap is raised', async () => {
    const t = seeded()
    let view = await t.tutor.openLesson(t.session.id, t.ids['relation'] as number)
    t.sessions.setLimits(t.session.id, { callCap: 1, spendCapUsd: null })
    view = await answerAndWait(t, view, 'RIGHT')
    expect(view.attempt?.status).toBe('saved')
    expect(view.blocked).toMatchObject({ kind: 'cap', calls: 1, callCap: 1 })
    t.sessions.setLimits(t.session.id, { callCap: 10, spendCapUsd: null })
    t.tutor.resumePending(t.session.id)
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
    expect(view.attempt?.status).toBe('graded')
    expect(view.blocked).toBeNull()
  })
})

describe('mastery at the threshold', () => {
  it('after a contested opening answer, says one correct unaided answer is missing and caps the meter (as in a real run)', async () => {
    const t = seeded()
    const relation = t.ids['relation'] as number
    // The diagnostic's inferences had already put the estimate high, as in the run this reproduces.
    t.tutor.learner.addEvidence(t.session.id, relation, 'override-known', { value: 0.97 })
    let view = await t.tutor.openLesson(t.session.id, relation)
    view = await answerAndWait(t, view, 'HALF')
    t.tutor.contest(view.attempt?.id ?? 0, 'VALID OBJECTION: the reason is there.')
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
    expect(view.attempt?.grades.map((g) => g.verdict)).toEqual(['partial', 'correct'])
    expect(view.mastery.p).toBeGreaterThanOrEqual(MASTERY.mastered)
    expect(view.mastery).toMatchObject({ mastered: false, gap: 'unaided', shown: MASTERY.mastered - 0.01 })
    expect(t.tutor.path(t.session.id).units[0]?.concepts.find((c) => c.id === relation)?.mastery.gap).toBe('unaided')
    expect(view.canFastTrack).toBe(true)
    view = await answerAndWait(t, t.tutor.continue(view.lessonId, true), 'RIGHT')
    expect(view.mastery).toMatchObject({ mastered: true, gap: null })
    expect(view.mastery.shown).toBe(view.mastery.p)
  })

  it('a contested unaided answer that becomes correct masters the concept and lets the lesson finish', async () => {
    const t = seeded()
    const relation = t.ids['relation'] as number
    t.tutor.learner.addEvidence(t.session.id, relation, 'override-known', { value: 0.9 })
    let view = await t.tutor.openLesson(t.session.id, relation)
    view = await answerAndWait(t, view, 'RIGHT')
    view = await answerAndWait(t, t.tutor.continue(view.lessonId, true), 'HALF')
    expect(view.question?.kind).toBe('unaided')
    expect(view.mastery.mastered).toBe(false)
    t.tutor.contest(view.attempt?.id ?? 0, 'VALID OBJECTION: my second sentence gives the reason.')
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
    expect(view.attempt?.grades.map((g) => g.verdict)).toEqual(['partial', 'correct'])
    expect(view.mastery).toMatchObject({ mastered: true, gap: null })
    expect(t.tutor.continue(view.lessonId).step).toBe('done')
  })
})
