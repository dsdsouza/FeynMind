import type Database from 'better-sqlite3'
import { systemClock, type AppClock } from '../clock'
import type { UsageSummary } from '../../shared/knowledge'
import type {
  AttemptView,
  CallEstimate,
  ConceptStatus,
  DiagnosticState,
  GradeView,
  LessonBlock,
  LessonQuestionView,
  LessonView,
  McqResult,
  PathState,
  LessonStep,
  StepState,
  StreamEvent,
  UnitStatus
} from '../../shared/tutor'
import { LESSON_STEPS } from '../../shared/tutor'
import { textTokens, type PromptLibrary, type UnitGraph } from '../knowledge'
import { LearnerRepo, MASTERY, unitStanding, type ConceptMastery } from '../learner'
import { PauseError, UserFacingError, type ModelTask, type ModelTaskResult, type Role } from '../providers'
import { DIAGNOSTIC_MAX_QUESTIONS, graphEdges, probeStatus, reachable, type ProbeNode } from './diagnostic'
import { DIAGNOSTIC_BUDGET, LESSON_BUDGET, retrievePassages, sourceRefs, type Passage, type RetrievalSource } from './passages'
import { TutorRepo, type AttemptRow, type LessonRow, type QuestionRow } from './repo'
import { verdictOf, type Criterion } from './schemas'
import { contestTask, diagnosticTask, explanationTask, gradeTask, gradingPromptName, lessonQuestionsTask, type ConceptBrief, type GradingInput, type TaskContext } from './tasks'

/** What the tutor needs from the providers module. */
export interface TutorProviders {
  modelForRole(role: Role): string
  run<T>(task: ModelTask<T>): Promise<ModelTaskResult<T>>
  runStream<T>(task: ModelTask<T>, onText: (text: string) => void, onReset: () => void): Promise<ModelTaskResult<T>>
  calibration(role: Role, prompt: string): { inputFactor: number; outputFactor: number; samples: number }
  costOf(model: string, tokens: { inputTokens: number; outputTokens: number }): number | null
  usageSummary(sessionId: number): UsageSummary
  safeErrorMessage(error: unknown): string
}

export interface TutorServiceOptions {
  db: Database.Database
  providers: TutorProviders
  /** The session's units with their concepts in learning order. */
  unitGraphs: (sessionId: number) => UnitGraph[]
  retrieval: RetrievalSource
  prompts: PromptLibrary
  /** Whether the user has confirmed the notice about sending material to the provider. */
  consentGiven: (sessionId: number) => boolean
  onLesson: (view: LessonView) => void
  onStream: (event: StreamEvent) => void
  onUsage: (usage: UsageSummary) => void
  /** The scheduling clock; the system clock when not given. */
  clock?: AppClock
}

/** Concepts per diagnostic question request. */
const DIAGNOSTIC_BATCH = 8
/** Questions in the check that confirms "I know this unit", and how many must be right. */
const CONFIRM_QUESTIONS = 3
const CONFIRM_PASS = 2
const MAX_ANSWER = 5000
const MAX_OBJECTION = 2000
/** Lesson answers graded by the model in a usual lesson: opening, guided, partial, one unaided. */
const USUAL_GRADED_ANSWERS = 4
const CAP_PREFIX = 'cap: '
/** Tokens of a rubric, the question and a typed answer, as a grade request adds them to the passages. */
const GRADED_TEXT_TOKENS = 250

interface CourseConcept {
  id: number
  name: string
  definition: string
  pages: { materialId: number; pageIndex: number }[]
  prerequisites: number[]
  unitId: number
  unitTitle: string
}

/**
 * The tutor module's public service: the diagnostic and confirming checks, the path with
 * standings and locks, lessons (ask first, explain with a worked example, then practice from
 * guided to unaided), grading against rubrics and contests. Every answer is saved before it is
 * graded; grading that was interrupted is done again when the lesson is opened, and a model
 * reply that already arrived comes from the cache at no cost.
 */
export class TutorService {
  readonly repo: TutorRepo
  readonly learner: LearnerRepo
  private readonly grading = new Map<number, Promise<void>>()
  private readonly explaining = new Map<number, Promise<void>>()
  private readonly blocks = new Map<number, LessonBlock>()
  private readonly abort = new AbortController()

  constructor(private readonly options: TutorServiceOptions) {
    this.repo = new TutorRepo(options.db)
    this.learner = new LearnerRepo(options.db, options.clock ?? systemClock)
  }

  /** Stops model requests in flight, waiting briefly so a reply that arrives is cached. */
  async stop(timeoutMs = 5_000): Promise<void> {
    this.abort.abort(new Error('The app is closing.'))
    const running = [...this.grading.values(), ...this.explaining.values()]
    await Promise.race([Promise.allSettled(running), new Promise((r) => setTimeout(r, timeoutMs))])
  }

  /** Waits until no grading or explanation is running (for tests). */
  async idle(): Promise<void> {
    while (this.grading.size > 0 || this.explaining.size > 0) await Promise.allSettled([...this.grading.values(), ...this.explaining.values()])
  }

  // The course

  /** Concepts of processed units in syllabus order, then learning order. A concept in two units counts in the first. */
  private course(sessionId: number): { graphs: UnitGraph[]; concepts: CourseConcept[] } {
    const graphs = this.options.unitGraphs(sessionId)
    const seen = new Set<number>()
    const concepts: CourseConcept[] = []
    for (const g of graphs) {
      for (const c of g.concepts) {
        if (seen.has(c.id)) continue
        seen.add(c.id)
        concepts.push({ ...c, unitId: g.unit.id, unitTitle: g.unit.title })
      }
    }
    return { graphs, concepts }
  }

  private conceptOf(sessionId: number, conceptId: number): { concept: CourseConcept; all: CourseConcept[] } {
    const { concepts } = this.course(sessionId)
    const concept = concepts.find((c) => c.id === conceptId)
    if (!concept) throw new UserFacingError('That concept is not part of a processed unit.')
    return { concept, all: concepts }
  }

  private brief(concept: CourseConcept, all: CourseConcept[]): ConceptBrief {
    const names = new Map(all.map((c) => [c.id, c.name]))
    return { name: concept.name, definition: concept.definition, prerequisites: concept.prerequisites.map((p) => names.get(p)).filter((n): n is string => n !== undefined) }
  }

  private ctx(sessionId: number, role: Role, prompt: string): TaskContext {
    return { sessionId, calibration: this.options.providers.calibration(role, prompt), signal: this.abort.signal }
  }

  private requireConsent(sessionId: number): void {
    if (!this.options.consentGiven(sessionId)) throw new UserFacingError('Confirm the notice about sending course material first.')
  }

  private async run<T>(sessionId: number, task: ModelTask<T>): Promise<T> {
    try {
      return (await this.options.providers.run(task)).value
    } finally {
      this.options.onUsage(this.options.providers.usageSummary(sessionId))
    }
  }

  // Path and standings

  path(sessionId: number): PathState {
    const { graphs, concepts } = this.course(sessionId)
    const mastery = this.learner.many(concepts.map((c) => c.id))
    const steps = this.repo.lessonSteps(sessionId)
    const overrides = this.repo.latestOverrides(sessionId)
    const names = new Map(concepts.map((c) => [c.id, c.name]))
    const status = (c: CourseConcept): ConceptStatus => {
      const m = mastery.get(c.id) as ConceptMastery
      const waitingFor = c.prerequisites.filter((p) => names.has(p) && !mastery.get(p)?.mastered).map((p) => names.get(p) as string)
      return {
        id: c.id,
        name: c.name,
        definition: c.definition,
        mastery: { p: m.p, shown: m.shown, band: m.band, mastered: m.mastered, gap: m.gap },
        locked: waitingFor.length > 0,
        waitingFor,
        lessonStep: steps.get(c.id) ?? null
      }
    }
    const byId = new Map(concepts.map((c) => [c.id, status(c)]))
    const units: UnitStatus[] = graphs.map((g) => {
      const own = concepts.filter((c) => c.unitId === g.unit.id).map((c) => byId.get(c.id) as ConceptStatus)
      return {
        id: g.unit.id,
        ordinal: g.unit.ordinal,
        title: g.unit.title,
        processed: g.concepts.length > 0,
        standing: g.concepts.length > 0 ? unitStanding(own.map((c) => c.mastery.band)) : 'not-assessed',
        concepts: own,
        mastered: own.filter((c) => c.mastery.mastered).length,
        override: overrides.get(g.unit.id) ?? null
      }
    })
    const nextConcept = concepts.find((c) => {
      const s = byId.get(c.id)
      return s && !s.locked && !s.mastery.mastered
    })
    const nextLesson = nextConcept ? (this.repo.lessonOfConcept(nextConcept.id) ?? null) : null
    const latest = this.repo.latestDiagnostic(sessionId, 'diagnostic')
    const open = this.repo.openLesson(sessionId)
    const openConcept = open ? concepts.find((c) => c.id === open.conceptId) : undefined
    return {
      sessionId,
      units,
      next: nextConcept
        ? {
            conceptId: nextConcept.id,
            name: nextConcept.name,
            unitTitle: nextConcept.unitTitle,
            estimate: this.lessonEstimate(nextLesson, nextConcept.id, nextLesson ? this.repo.attemptsOfLesson(nextLesson.id) : [])
          }
        : null,
      diagnostic: {
        status: !latest ? 'not-started' : latest.status === 'in-progress' ? 'in-progress' : 'done',
        estimate: concepts.length > 0 ? this.diagnosticEstimate(sessionId, concepts) : null
      },
      openLesson: open && openConcept ? { conceptId: open.conceptId, name: openConcept.name, step: open.step } : null
    }
  }

  /** "Treat this unit as new": accepted without a check. Lowers every concept not yet mastered to the starting estimate. */
  markUnitNew(sessionId: number, unitId: number): PathState {
    const { concepts } = this.course(sessionId)
    const own = concepts.filter((c) => c.unitId === unitId)
    if (own.length === 0) throw new UserFacingError('That unit has no concepts yet.')
    this.options.db.transaction(() => {
      this.repo.addOverride(sessionId, unitId, 'new', null, 'accepted')
      for (const c of own) if (!this.learner.get(c.id).mastered) this.learner.addEvidence(sessionId, c.id, 'override-new', { value: MASTERY.prior })
    })()
    return this.path(sessionId)
  }

  // Diagnostic

  private estimateOf(model: string, calls: number, inputTokens: number, outputTokens: number): CallEstimate {
    return { calls, inputTokens, outputTokens, costUsd: this.options.providers.costOf(model, { inputTokens, outputTokens }) }
  }

  /** Calls and tokens to write the diagnostic's questions for concepts that have none yet. Grading is local. */
  private diagnosticEstimate(sessionId: number, concepts: CourseConcept[]): CallEstimate {
    const prompt = this.options.prompts.get('diagnostic-questions')
    const model = this.options.providers.modelForRole('teaching')
    const missing = concepts.filter((c) => this.repo.questionsOf(c.id, 'diagnostic').length < 2)
    const calls = Math.ceil(missing.length / DIAGNOSTIC_BATCH)
    const variable = missing.reduce((n, c) => n + textTokens(`${c.name}: ${c.definition}`) + DIAGNOSTIC_BUDGET, 0)
    const f = this.options.providers.calibration('teaching', prompt.name)
    const weight = f.samples / (f.samples + 3)
    const input = (calls * (textTokens(prompt.system) + textTokens(prompt.template)) + variable) * (1 + (f.inputFactor - 1) * weight)
    const output = (calls * prompt.outputBase + prompt.outputRatio * variable) * (1 + (f.outputFactor - 1) * weight)
    return this.estimateOf(model, calls, Math.round(input), Math.round(output))
  }

  /** Writes and stores the two diagnostic questions of each concept that has none, in batches. Stored batches are never asked for again. */
  private async ensureDiagnosticQuestions(sessionId: number, concepts: CourseConcept[], all: CourseConcept[]): Promise<void> {
    const missing = concepts.filter((c) => this.repo.questionsOf(c.id, 'diagnostic').length < 2)
    const prompt = this.options.prompts.get('diagnostic-questions')
    for (let i = 0; i < missing.length; i += DIAGNOSTIC_BATCH) {
      const batch = missing.slice(i, i + DIAGNOSTIC_BATCH)
      const passages: Passage[] = []
      const perConcept = new Map<number, Passage[]>()
      for (const c of batch) {
        const found = await retrievePassages(this.options.retrieval, sessionId, c, DIAGNOSTIC_BUDGET, passages.length + 1)
        // A passage already sent for another concept in the batch is not sent twice.
        const fresh = found.filter((p) => !passages.some((q) => q.chunkId === p.chunkId))
        fresh.forEach((p, j) => (p.tag = `S${passages.length + j + 1}`))
        passages.push(...fresh)
        perConcept.set(c.id, [...fresh, ...passages.filter((q) => found.some((p) => p.chunkId === q.chunkId) && !fresh.includes(q))])
      }
      const keyed = batch.map((c, j) => ({ ...this.brief(c, all), key: `C${j + 1}` }))
      const task = diagnosticTask(prompt, keyed, passages, this.ctx(sessionId, 'teaching', prompt.name))
      const questions = await this.run(sessionId, task)
      this.options.db.transaction(() => {
        batch.forEach((c, j) => {
          const forConcept = questions.filter((q) => q.concept === `C${j + 1}`)
          const ordered = [...forConcept.filter((q) => q.purpose === 'probe'), ...forConcept.filter((q) => q.purpose === 'confirm')]
          this.repo.addQuestions(
            sessionId,
            c.id,
            ordered.map((q) => ({
              kind: 'diagnostic' as const,
              stem: q.stem,
              choices: q.choices,
              answerIndex: q.answer,
              explanation: q.why,
              pages: q.pages,
              sources: perConcept.get(c.id) ?? [],
              outsideSources: q.pages.length === 0
            })),
            { name: prompt.name, version: prompt.version, cacheKey: task.contentKey }
          )
        })
      })()
    }
  }

  /** Starts the diagnostic (writing its questions first if needed), or returns the one in progress. */
  async startDiagnostic(sessionId: number): Promise<DiagnosticState> {
    const current = this.repo.latestDiagnostic(sessionId, 'diagnostic')
    if (current?.status === 'in-progress') return this.diagnosticState(current.id)
    const { concepts } = this.course(sessionId)
    if (concepts.length === 0) throw new UserFacingError('Process a unit first: the diagnostic asks about its concepts.')
    this.requireConsent(sessionId)
    await this.ensureDiagnosticQuestions(sessionId, concepts, concepts)
    return this.diagnosticState(this.repo.createDiagnostic(sessionId, 'diagnostic', null))
  }

  /** "I know this unit": starts a short check on the unit's most advanced concepts. */
  async claimUnitKnown(sessionId: number, unitId: number): Promise<DiagnosticState> {
    const { concepts } = this.course(sessionId)
    const own = concepts.filter((c) => c.unitId === unitId)
    if (own.length === 0) throw new UserFacingError('That unit has no concepts yet.')
    this.requireConsent(sessionId)
    const checked = this.confirmConcepts(own)
    await this.ensureDiagnosticQuestions(sessionId, checked, concepts)
    const id = this.repo.createDiagnostic(sessionId, 'confirm', unitId)
    this.repo.addOverride(sessionId, unitId, 'known', id, 'pending')
    return this.diagnosticState(id)
  }

  /** The unit's most advanced concepts: last in learning order, which build on the rest. */
  private confirmConcepts(own: CourseConcept[]): CourseConcept[] {
    return own.slice(-CONFIRM_QUESTIONS)
  }

  diagnosticState(diagnosticId: number): DiagnosticState {
    const d = this.repo.getDiagnostic(diagnosticId)
    if (!d) throw new UserFacingError('That quiz no longer exists.')
    const { concepts, graphs } = this.course(d.sessionId)
    const attempts = this.repo.attemptsOfDiagnostic(d.id)
    const names = new Map(concepts.map((c) => [c.id, c.name]))
    const results: McqResult[] = attempts.map((a) => {
      const q = this.repo.getQuestion(a.questionId) as QuestionRow
      return { conceptName: names.get(a.conceptId) ?? '?', stem: q.stem, choices: q.choices ?? [], answerIndex: q.answerIndex ?? 0, chosen: a.choiceIndex, why: q.explanation ?? '' }
    })
    const next = d.status === 'in-progress' ? this.nextProbe(d.id) : null
    const unitTitle = d.unitId === null ? null : (graphs.find((g) => g.unit.id === d.unitId)?.unit.title ?? null)
    const outcome = d.kind === 'confirm' ? this.repo.overrideOfDiagnostic(d.id)?.outcome : null
    return {
      id: d.id,
      kind: d.kind,
      unitTitle,
      status: d.status === 'in-progress' ? 'in-progress' : 'done',
      question: next
        ? {
            questionId: next.question.id,
            conceptName: names.get(next.question.conceptId) ?? '?',
            stem: next.question.stem,
            choices: next.question.choices ?? [],
            number: attempts.length + 1,
            max: next.max
          }
        : null,
      results,
      outcome: outcome === 'confirmed' || outcome === 'not-confirmed' ? outcome : null
    }
  }

  private probeNodes(sessionId: number): ProbeNode[] {
    return this.course(sessionId).concepts.map((c) => ({ id: c.id, prerequisites: c.prerequisites }))
  }

  /** The next question of a quiz in progress, or null when it is over. */
  private nextProbe(diagnosticId: number): { question: QuestionRow; max: number } | null {
    const d = this.repo.getDiagnostic(diagnosticId) as NonNullable<ReturnType<TutorRepo['getDiagnostic']>>
    const attempts = this.repo.attemptsOfDiagnostic(d.id)
    if (d.kind === 'confirm') {
      const own = this.course(d.sessionId).concepts.filter((c) => c.unitId === d.unitId)
      const checked = this.confirmConcepts(own)
      const c = checked[attempts.length]
      const question = c ? this.repo.questionsOf(c.id, 'diagnostic')[1] : undefined
      return question ? { question, max: checked.length } : null
    }
    const answers = this.diagnosticAnswers(d.id)
    const status = probeStatus(this.probeNodes(d.sessionId), answers)
    if (status.next === null) return null
    const question = this.repo.questionsOf(status.next, 'diagnostic')[0]
    return question ? { question, max: Math.min(DIAGNOSTIC_MAX_QUESTIONS, this.probeNodes(d.sessionId).length) } : null
  }

  private diagnosticAnswers(diagnosticId: number): Map<number, boolean> {
    const answers = new Map<number, boolean>()
    for (const a of this.repo.attemptsOfDiagnostic(diagnosticId)) answers.set(a.conceptId, this.repo.finalGrade(a.id)?.verdict === 'correct')
    return answers
  }

  /** Records a multiple-choice answer (null = "I don't know"), grades it here and updates mastery. */
  answerDiagnostic(diagnosticId: number, questionId: number, choice: number | null): DiagnosticState {
    const d = this.repo.getDiagnostic(diagnosticId)
    if (!d || d.status !== 'in-progress') throw new UserFacingError('That quiz is over.')
    const next = this.nextProbe(d.id)
    if (!next || next.question.id !== questionId) throw new UserFacingError('That question was already answered. The quiz has moved on.')
    const q = next.question
    const choices = q.choices ?? []
    if (choice !== null && (!Number.isInteger(choice) || choice < 0 || choice >= choices.length)) throw new UserFacingError('Choose one of the answers.')
    const correct = choice === q.answerIndex
    const previous = this.repo.attemptsOfDiagnostic(d.id)
    const shownAt = previous[previous.length - 1]?.submittedAt ?? d.startedAt
    const before = d.kind === 'diagnostic' ? probeStatus(this.probeNodes(d.sessionId), this.diagnosticAnswers(d.id)) : null

    this.options.db.transaction(() => {
      const attemptId = this.repo.addAttempt({
        sessionId: d.sessionId,
        conceptId: q.conceptId,
        questionId: q.id,
        lessonId: null,
        diagnosticId: d.id,
        answer: choice === null ? '' : (choices[choice] ?? ''),
        choiceIndex: choice,
        skipped: choice === null,
        shownAt
      })
      const right = choices[q.answerIndex ?? 0] ?? ''
      this.repo.addGrade(attemptId, {
        pass: 1,
        verdict: correct ? 'correct' : 'incorrect',
        score: correct ? 1 : 0,
        criteria: [],
        reason: correct ? 'You chose the right answer.' : choice === null ? `You chose "I don't know". The answer is: ${right}` : `The answer is: ${right}`,
        feedback: '',
        pages: q.pages,
        outsideSources: q.outsideSources,
        gradedBy: 'local'
      })
      this.learner.addEvidence(d.sessionId, q.conceptId, 'diagnostic', { attemptId })
      if (d.kind === 'diagnostic' && before) this.inferFromAnswer(d.sessionId, q.conceptId, correct, before.unknown)
      if (this.nextProbe(d.id) === null) this.finishQuiz(d.id)
    })()
    return this.diagnosticState(d.id)
  }

  /** A correct answer counts for every prerequisite; a miss marks every concept depending on it as new (once). */
  private inferFromAnswer(sessionId: number, conceptId: number, correct: boolean, unknownBefore: Set<number>): void {
    const { prereqsOf, dependentsOf } = graphEdges(this.probeNodes(sessionId))
    if (correct) {
      for (const p of reachable(conceptId, prereqsOf)) this.learner.addEvidence(sessionId, p, 'inferred-known')
    } else {
      for (const dep of reachable(conceptId, dependentsOf)) if (!unknownBefore.has(dep)) this.learner.addEvidence(sessionId, dep, 'inferred-new')
    }
  }

  private finishQuiz(diagnosticId: number): void {
    const d = this.repo.getDiagnostic(diagnosticId)
    if (!d) return
    this.repo.finishDiagnostic(d.id, 'done')
    if (d.kind !== 'confirm' || d.unitId === null) return
    const right = this.repo.attemptsOfDiagnostic(d.id).filter((a) => this.repo.finalGrade(a.id)?.verdict === 'correct').length
    const confirmed = right >= CONFIRM_PASS
    this.repo.setOverrideOutcome(d.id, confirmed ? 'confirmed' : 'not-confirmed')
    if (confirmed) {
      for (const c of this.course(d.sessionId).concepts.filter((x) => x.unitId === d.unitId)) {
        this.learner.addEvidence(d.sessionId, c.id, 'override-known', { value: MASTERY.overrideKnown })
      }
    }
  }

  // Lessons

  /** The lesson that was left part way, if any, reopened where it stopped: unfinished grading and explanation resume. */
  async currentLesson(sessionId: number): Promise<LessonView | null> {
    const open = this.repo.openLesson(sessionId)
    if (!open) return null
    const { concept, all } = this.conceptOf(sessionId, open.conceptId)
    await this.prepare(open, concept, all)
    return this.view(open.id)
  }

  /**
   * Opens a concept's lesson, creating it (retrieving its passages and writing its questions, one
   * call, unless they are stored) the first time. Grading left unfinished is resumed.
   */
  async openLesson(sessionId: number, conceptId: number): Promise<LessonView> {
    const { concept, all } = this.conceptOf(sessionId, conceptId)
    let lesson = this.repo.lessonOfConcept(conceptId)
    if (!lesson) {
      const locked = this.path(sessionId).units.flatMap((u) => u.concepts).find((c) => c.id === conceptId)
      if (locked?.locked) throw new UserFacingError(`Learn ${locked.waitingFor.join(', ')} first.`)
      this.requireConsent(sessionId)
      const passages = await retrievePassages(this.options.retrieval, sessionId, concept, LESSON_BUDGET)
      lesson = this.repo.lessonOfConcept(conceptId) ?? this.repo.createLesson(sessionId, conceptId, passages)
    }
    await this.prepare(lesson, concept, all)
    return this.view(lesson.id)
  }

  /** Writes the lesson's questions if needed, then resumes grading and the explanation. */
  private async prepare(lesson: LessonRow, concept: CourseConcept, all: CourseConcept[]): Promise<void> {
    this.blocks.delete(lesson.id)
    if (lesson.questionId === null && lesson.step === 'opening') {
      try {
        await this.ensureLessonQuestions(lesson, concept, all)
      } catch (error) {
        this.block(lesson, error)
        return
      }
      const opening = this.repo.questionsOf(concept.id, 'opening')[0]
      if (opening) this.repo.setLessonStep(lesson.id, 'opening', opening.id)
    }
    for (const a of this.repo.ungraded(lesson.sessionId).filter((x) => x.lessonId === lesson.id)) this.startGrading(a.id)
    const fresh = this.repo.getLesson(lesson.id) as LessonRow
    if (fresh.step === 'explain' && fresh.explanation === null) this.startExplanation(fresh.id)
  }

  private async ensureLessonQuestions(lesson: LessonRow, concept: CourseConcept, all: CourseConcept[]): Promise<void> {
    if (this.repo.questionsOf(concept.id, 'opening').length > 0) return
    const prompt = this.options.prompts.get('lesson-questions')
    const task = lessonQuestionsTask(prompt, this.brief(concept, all), lesson.passages, this.ctx(lesson.sessionId, 'teaching', prompt.name))
    const result = await this.run(lesson.sessionId, task)
    if (this.repo.questionsOf(concept.id, 'opening').length > 0) return
    this.repo.addQuestions(
      lesson.sessionId,
      concept.id,
      result.questions.map((q) => ({ kind: q.kind, stem: q.stem, referenceAnswer: q.referenceAnswer, criteria: q.criteria, scaffold: q.scaffold, pages: q.pages, sources: lesson.passages, outsideSources: !result.covered })),
      { name: prompt.name, version: prompt.version, cacheKey: task.contentKey }
    )
  }

  private block(lesson: LessonRow, error: unknown): void {
    this.blocks.set(lesson.id, this.blockOf(lesson.sessionId, error))
  }

  private blockOf(sessionId: number, error: unknown): LessonBlock {
    const message = this.options.providers.safeErrorMessage(error)
    if (error instanceof PauseError && error.reason === 'cap') {
      const usage = this.options.providers.usageSummary(sessionId)
      return { kind: 'cap', message, calls: usage.calls, callCap: usage.callCap ?? usage.calls }
    }
    return { kind: 'error', message }
  }

  private requireLesson(lessonId: number): LessonRow {
    const lesson = this.repo.getLesson(lessonId)
    if (!lesson) throw new UserFacingError('That lesson no longer exists.')
    return lesson
  }

  /** Keeps what the learner has typed (or dictated) so far, so closing the app loses nothing. */
  saveDraft(lessonId: number, field: 'answer' | 'reasoning', text: string): void {
    this.repo.saveDraft(this.requireLesson(lessonId).id, field, text.slice(0, MAX_ANSWER))
  }

  /**
   * Saves an answer, then grades it. The answer is in the database before the grading request
   * starts; the returned view shows it as saved and the graded view follows as an event. "I don't
   * know" (skipped) is graded here without a call. The reasoning is optional and saved with the
   * answer in the same row; with reasoning, the grader judges both.
   */
  answer(lessonId: number, questionId: number, text: string, skipped: boolean, reasoningText = ''): LessonView {
    const lesson = this.requireLesson(lessonId)
    if (lesson.questionId !== questionId || lesson.step === 'explain' || lesson.step === 'done') throw new UserFacingError('That question is no longer the current one.')
    if (this.repo.attemptsOfLesson(lesson.id).some((a) => a.questionId === questionId)) throw new UserFacingError('That question was already answered.')
    const answer = skipped ? '' : text.trim()
    if (!skipped && answer === '') throw new UserFacingError('Type an answer, or choose "I don\'t know".')
    if (answer.length > MAX_ANSWER) throw new UserFacingError(`Keep the answer under ${MAX_ANSWER} characters.`)
    const reasoning = skipped ? '' : reasoningText.trim()
    if (reasoning.length > MAX_ANSWER) throw new UserFacingError(`Keep your thinking under ${MAX_ANSWER} characters.`)
    const attemptId = this.options.db.transaction(() => {
      const id = this.repo.addAttempt({
        sessionId: lesson.sessionId,
        conceptId: lesson.conceptId,
        questionId,
        lessonId: lesson.id,
        diagnosticId: null,
        answer,
        reasoning,
        choiceIndex: null,
        skipped,
        shownAt: lesson.questionShownAt ?? lesson.updatedAt
      })
      this.repo.clearDrafts(lesson.id)
      if (skipped) {
        this.repo.addGrade(id, {
          pass: 1,
          verdict: 'incorrect',
          score: 0,
          criteria: [],
          reason: 'You chose not to answer this one. That is fine: the explanation and practice cover it.',
          feedback: '',
          pages: [],
          outsideSources: false,
          gradedBy: 'local'
        })
        this.learner.addEvidence(lesson.sessionId, lesson.conceptId, 'answer', { attemptId: id })
      }
      return id
    })()
    if (!skipped) this.startGrading(attemptId)
    return this.view(lesson.id)
  }

  /** Contests a grade once: saves the objection, then asks for a second grade that sees it. Both grades are kept. */
  contest(attemptId: number, objection: string): LessonView {
    const attempt = this.repo.getAttempt(attemptId)
    if (!attempt?.lessonId) throw new UserFacingError('That answer cannot be contested.')
    const text = objection.trim()
    if (text === '') throw new UserFacingError('Say why you think the grade is wrong.')
    if (text.length > MAX_OBJECTION) throw new UserFacingError(`Keep the objection under ${MAX_OBJECTION} characters.`)
    if (attempt.skipped || attempt.status !== 'graded') throw new UserFacingError('Only a graded answer can be contested.')
    if (attempt.objection !== null) throw new UserFacingError('A grade can be contested only once.')
    this.repo.saveObjection(attempt.id, text)
    this.startGrading(attempt.id)
    return this.view(attempt.lessonId)
  }

  /** Grades every lesson answer of the session still waiting (after the cap was raised, say). */
  resumePending(sessionId: number): void {
    for (const a of this.repo.ungraded(sessionId)) this.startGrading(a.id)
  }

  /** Tries again whatever stopped the lesson: writing its questions, grading or the explanation. */
  async retry(lessonId: number): Promise<LessonView> {
    const lesson = this.requireLesson(lessonId)
    const { concept, all } = this.conceptOf(lesson.sessionId, lesson.conceptId)
    for (const a of this.repo.attemptsOfLesson(lesson.id)) if (a.error) this.repo.setAttemptError(a.id, null)
    await this.prepare(lesson, concept, all)
    return this.view(lesson.id)
  }

  private startGrading(attemptId: number): void {
    if (this.grading.has(attemptId)) return
    const work = this.grade(attemptId).finally(() => this.grading.delete(attemptId))
    this.grading.set(attemptId, work)
  }

  private async grade(attemptId: number): Promise<void> {
    const attempt = this.repo.getAttempt(attemptId)
    if (!attempt?.lessonId) return
    const lessonId = attempt.lessonId
    try {
      if (attempt.status === 'saved') await this.firstGrade(attempt)
      else if (attempt.objection !== null && !this.repo.grades(attempt.id).some((g) => g.pass === 2)) await this.secondGrade(attempt)
    } catch (error) {
      if (this.abort.signal.aborted) return
      const block = this.blockOf(attempt.sessionId, error)
      this.repo.setAttemptError(attempt.id, block.kind === 'cap' ? `${CAP_PREFIX}${block.message}` : block.message)
    }
    if (!this.abort.signal.aborted) this.options.onLesson(this.view(lessonId))
  }

  private gradingInput(attempt: AttemptRow): { question: QuestionRow; input: GradingInput } {
    const question = this.repo.getQuestion(attempt.questionId)
    if (!question) throw new Error('The question of this answer is gone.')
    return {
      question,
      input: { question: question.scaffold ? `${question.stem}\n\nScaffold given to the student:\n${question.scaffold}` : question.stem, referenceAnswer: question.referenceAnswer ?? '', criteria: question.criteria, passages: question.sources, answer: attempt.answer, reasoning: attempt.reasoning }
    }
  }

  private async firstGrade(attempt: AttemptRow): Promise<void> {
    const { question, input } = this.gradingInput(attempt)
    const prompt = this.options.prompts.get(gradingPromptName('grade', input))
    const task = gradeTask(prompt, input, this.ctx(attempt.sessionId, 'grading', prompt.name))
    const result = await this.run(attempt.sessionId, task)
    const { verdict, score } = verdictOf(question.criteria, result.criteria, result.reasoning?.judgment ?? null)
    this.options.db.transaction(() => {
      if (this.repo.getAttempt(attempt.id)?.status !== 'saved') return
      this.repo.addGrade(attempt.id, {
        pass: 1,
        verdict,
        score,
        criteria: result.criteria,
        reason: result.reason,
        feedback: result.feedback,
        pages: result.pages,
        outsideSources: result.outsideSources,
        reasoningJudgment: result.reasoning?.judgment ?? null,
        reasoningComment: result.reasoning?.comment ?? null,
        gradedBy: 'model',
        model: this.options.providers.modelForRole('grading'),
        promptVersion: prompt.version,
        cacheKey: task.contentKey
      })
      this.learner.addEvidence(attempt.sessionId, attempt.conceptId, 'answer', { attemptId: attempt.id })
    })()
  }

  private async secondGrade(attempt: AttemptRow): Promise<void> {
    const first = this.repo.grades(attempt.id).find((g) => g.pass === 1)
    if (!first || attempt.objection === null) return
    const { question, input } = this.gradingInput(attempt)
    const prompt = this.options.prompts.get(gradingPromptName('grade-contest', input))
    const firstReasoning = first.reasoningJudgment ? { judgment: first.reasoningJudgment, comment: first.reasoningComment ?? '' } : null
    const task = contestTask(prompt, input, { verdict: first.verdict, criteria: first.criteria, reason: first.reason, reasoning: firstReasoning }, attempt.objection, this.ctx(attempt.sessionId, 'grading', prompt.name))
    const result = await this.run(attempt.sessionId, task)
    const { verdict, score } = verdictOf(question.criteria, result.criteria, result.reasoning?.judgment ?? null)
    this.options.db.transaction(() => {
      if (this.repo.grades(attempt.id).some((g) => g.pass === 2)) return
      this.repo.addGrade(attempt.id, {
        pass: 2,
        verdict,
        score,
        criteria: result.criteria,
        reason: result.reason,
        feedback: result.feedback,
        pages: result.pages,
        outsideSources: result.outsideSources,
        objection: attempt.objection,
        assessment: result.assessment,
        reasoningJudgment: result.reasoning?.judgment ?? null,
        reasoningComment: result.reasoning?.comment ?? null,
        gradedBy: 'model',
        model: this.options.providers.modelForRole('grading'),
        promptVersion: prompt.version,
        cacheKey: task.contentKey
      })
      this.learner.regrade(attempt.sessionId, attempt.conceptId, attempt.id)
    })()
  }

  private startExplanation(lessonId: number): void {
    if (this.explaining.has(lessonId)) return
    const work = this.explain(lessonId).finally(() => this.explaining.delete(lessonId))
    this.explaining.set(lessonId, work)
  }

  /** Streams the explanation and worked example, then stores them. Interrupted, it starts again; a reply that arrived comes from the cache. */
  private async explain(lessonId: number): Promise<void> {
    const lesson = this.requireLesson(lessonId)
    try {
      const { concept, all } = this.conceptOf(lesson.sessionId, lesson.conceptId)
      const prompt = this.options.prompts.get('lesson-explain')
      const task = explanationTask(prompt, this.brief(concept, all), lesson.passages, this.ctx(lesson.sessionId, 'teaching', prompt.name))
      try {
        const result = await this.options.providers.runStream(
          task,
          (text) => this.options.onStream({ lessonId, kind: 'text', text }),
          () => this.options.onStream({ lessonId, kind: 'reset', text: '' })
        )
        this.repo.saveExplanation(lessonId, result.value.markdown, result.value.outsideSources)
      } finally {
        this.options.onUsage(this.options.providers.usageSummary(lesson.sessionId))
      }
    } catch (error) {
      if (this.abort.signal.aborted) return
      this.options.onStream({ lessonId, kind: 'reset', text: '' })
      this.block(lesson, error)
    }
    if (!this.abort.signal.aborted) this.options.onLesson(this.view(lessonId))
  }

  /**
   * Moves the lesson on after the current answer is graded (or the explanation read):
   * opening, explanation, guided, partial, then unaided questions until the concept is mastered.
   * `fastTrack` skips from the opening question to an unaided one when mastery allows.
   */
  continue(lessonId: number, fastTrack = false): LessonView {
    const lesson = this.requireLesson(lessonId)
    const attempts = this.repo.attemptsOfLesson(lesson.id)
    const current = attempts.find((a) => a.questionId === lesson.questionId)
    const first = (kind: 'guided' | 'partial'): number | null => this.repo.questionsOf(lesson.conceptId, kind)[0]?.id ?? null
    const unanswered = this.repo.questionsOf(lesson.conceptId, 'unaided').find((q) => !attempts.some((a) => a.questionId === q.id))
    if (lesson.step === 'explain') {
      if (lesson.explanation === null) throw new UserFacingError('The explanation is not ready yet.')
      this.repo.setLessonStep(lesson.id, 'guided', first('guided'))
      return this.view(lesson.id)
    }
    if (lesson.step === 'done') return this.view(lesson.id)
    if (current?.status !== 'graded') throw new UserFacingError('Answer the question first; it is graded before the lesson moves on.')
    const mastery = this.learner.get(lesson.conceptId)
    switch (lesson.step) {
      case 'opening':
        if (fastTrack && mastery.p >= MASTERY.fastTrack && unanswered) this.repo.setLessonStep(lesson.id, 'unaided', unanswered.id)
        else {
          this.repo.setLessonStep(lesson.id, 'explain', null)
          this.startExplanation(lesson.id)
        }
        break
      case 'guided':
        this.repo.setLessonStep(lesson.id, 'partial', first('partial'))
        break
      case 'partial':
      case 'unaided':
        if (mastery.mastered) this.repo.setLessonStep(lesson.id, 'done', null)
        else if (unanswered) this.repo.setLessonStep(lesson.id, 'unaided', unanswered.id)
        else throw new UserFacingError('Every question of this lesson is answered. Ask for more questions to keep practising.')
        break
    }
    return this.view(lesson.id)
  }

  /** Writes three more unaided questions (one call) when all are answered and the concept is not mastered. */
  async moreQuestions(lessonId: number): Promise<LessonView> {
    const lesson = this.requireLesson(lessonId)
    if (!this.view(lesson.id).canMoreQuestions) throw new UserFacingError('Finish the questions you have first.')
    const { concept, all } = this.conceptOf(lesson.sessionId, lesson.conceptId)
    const prompt = this.options.prompts.get('lesson-questions')
    const asked = this.repo.stemsOf(concept.id)
    const task = lessonQuestionsTask(prompt, this.brief(concept, all), lesson.passages, this.ctx(lesson.sessionId, 'teaching', prompt.name), asked)
    try {
      const result = await this.run(lesson.sessionId, task)
      const ids = this.repo.addQuestions(
        lesson.sessionId,
        concept.id,
        result.questions.map((q) => ({ kind: q.kind, stem: q.stem, referenceAnswer: q.referenceAnswer, criteria: q.criteria, scaffold: null, pages: q.pages, sources: lesson.passages, outsideSources: !result.covered })),
        { name: prompt.name, version: prompt.version, cacheKey: task.contentKey }
      )
      if (ids[0] !== undefined) this.repo.setLessonStep(lesson.id, 'unaided', ids[0])
    } catch (error) {
      this.block(lesson, error)
    }
    return this.view(lesson.id)
  }

  // Views

  view(lessonId: number): LessonView {
    const lesson = this.requireLesson(lessonId)
    const { concept, all } = this.conceptOf(lesson.sessionId, lesson.conceptId)
    const question = lesson.questionId === null ? undefined : this.repo.getQuestion(lesson.questionId)
    const attempts = this.repo.attemptsOfLesson(lesson.id)
    const attempt = question ? attempts.find((a) => a.questionId === question.id) : undefined
    const m = this.learner.get(concept.id)
    const unaided = this.repo.questionsOf(concept.id, 'unaided')
    const unanswered = unaided.filter((q) => !attempts.some((a) => a.questionId === q.id))
    const graded = attempt?.status === 'graded'
    const path = this.path(lesson.sessionId)
    const next = path.next && path.next.conceptId !== concept.id ? { conceptId: path.next.conceptId, name: path.next.name } : null
    const opening = this.repo.questionsOf(concept.id, 'opening')[0]
    return {
      lessonId: lesson.id,
      concept: { id: concept.id, name: concept.name, definition: concept.definition, unitTitle: concept.unitTitle, prerequisites: this.brief(concept, all).prerequisites },
      step: lesson.step,
      steps: this.stepStates(lesson, attempts),
      question: question ? this.questionView(question, unaided) : null,
      attempt: attempt ? this.attemptView(attempt, question as QuestionRow) : null,
      draft: lesson.draft,
      draftReasoning: lesson.draftReasoning,
      explanation: lesson.explanation === null ? null : { markdown: lesson.explanation, outsideSources: lesson.explanationOutside },
      explaining: this.explaining.has(lesson.id),
      sources: sourceRefs(lesson.passages),
      questionsOutsideSources: opening?.outsideSources ?? false,
      mastery: { p: m.p, shown: m.shown, band: m.band, mastered: m.mastered, gap: m.gap },
      canFastTrack: lesson.step === 'opening' && graded && m.p >= MASTERY.fastTrack && unanswered.length > 0,
      canMoreQuestions: (lesson.step === 'unaided' || lesson.step === 'partial') && graded && !m.mastered && unanswered.length === 0,
      estimate: this.lessonEstimate(lesson, concept.id, attempts),
      blocked: this.lessonBlock(lesson, attempts),
      next
    }
  }

  /** A step before the current one is done if the learner worked through it, skipped if not. */
  private stepStates(lesson: LessonRow, attempts: AttemptRow[]): Record<LessonStep, StepState> {
    const kinds = new Map(this.repo.questionsOf(lesson.conceptId).map((q) => [q.id, q.kind]))
    const answered = new Set<string>(attempts.map((a) => kinds.get(a.questionId) ?? ''))
    const current = LESSON_STEPS.indexOf(lesson.step)
    const worked = (step: LessonStep): boolean => (step === 'explain' ? lesson.explanation !== null : answered.has(step))
    return Object.fromEntries(
      LESSON_STEPS.map((step, i) => [step, i === current ? 'current' : i > current ? 'upcoming' : worked(step) ? 'done' : 'skipped'])
    ) as Record<LessonStep, StepState>
  }

  private questionView(q: QuestionRow, unaided: QuestionRow[]): LessonQuestionView {
    return { id: q.id, kind: q.kind as LessonQuestionView['kind'], stem: q.stem, scaffold: q.scaffold, number: q.kind === 'unaided' ? unaided.findIndex((u) => u.id === q.id) + 1 : 1 }
  }

  private attemptView(a: AttemptRow, q: QuestionRow): AttemptView {
    const rubric = new Map<string, Criterion>(q.criteria.map((c) => [c.id, c]))
    const grades: GradeView[] = this.repo.grades(a.id).map((g) => ({
      pass: g.pass,
      verdict: g.verdict,
      score: g.score,
      reason: g.reason,
      feedback: g.feedback,
      criteria: g.criteria.map((r) => {
        const c = rubric.get(r.id)
        return { id: r.id, text: c?.text ?? r.id, points: c?.points ?? 1, essential: c?.essential ?? false, met: r.met, evidence: r.evidence }
      }),
      pages: g.pages,
      outsideSources: g.outsideSources,
      objection: g.objection,
      assessment: g.assessment,
      reasoning: g.reasoningJudgment ? { judgment: g.reasoningJudgment, comment: g.reasoningComment ?? '' } : null,
      gradedBy: g.gradedBy,
      createdAt: g.createdAt
    }))
    const contestPending = a.objection !== null && !grades.some((g) => g.pass === 2)
    return {
      id: a.id,
      answer: a.answer,
      reasoning: a.reasoning,
      skipped: a.skipped,
      status: a.status,
      error: a.error?.startsWith(CAP_PREFIX) ? a.error.slice(CAP_PREFIX.length) : a.error,
      grades,
      contestPending,
      canContest: a.status === 'graded' && !a.skipped && a.objection === null && grades.every((g) => g.gradedBy === 'model'),
      submittedAt: a.submittedAt
    }
  }

  private lessonBlock(lesson: LessonRow, attempts: AttemptRow[]): LessonBlock | null {
    const failed = attempts.find((a) => a.error !== null && (a.status === 'saved' || (a.objection !== null && !this.repo.grades(a.id).some((g) => g.pass === 2))))
    if (failed?.error) {
      if (failed.error.startsWith(CAP_PREFIX)) {
        const usage = this.options.providers.usageSummary(lesson.sessionId)
        return { kind: 'cap', message: failed.error.slice(CAP_PREFIX.length), calls: usage.calls, callCap: usage.callCap ?? usage.calls }
      }
      return { kind: 'error', message: failed.error }
    }
    return this.blocks.get(lesson.id) ?? null
  }

  /** Calls the rest of this lesson usually needs: its questions and explanation if not written yet, and a grade per remaining usual answer. */
  /**
   * Calls the rest of a lesson usually needs: its questions and explanation if not written yet,
   * and a grade per remaining usual answer. Before the lesson exists, its passages are assumed to
   * fill the retrieval budget.
   */
  private lessonEstimate(lesson: LessonRow | null, conceptId: number, attempts: AttemptRow[]): CallEstimate {
    const model = this.options.providers.modelForRole('teaching')
    // input: the variable part of the prompt; output: the part the prompt's output ratio applies to.
    const parts: { prompt: string; role: Role; count: number; input: number; output: number }[] = []
    const passageTokens = lesson ? lesson.passages.reduce((n, p) => n + textTokens(p.text) + 30, 0) : LESSON_BUDGET
    const done = lesson?.step === 'done'
    if (this.repo.questionsOf(conceptId, 'opening').length === 0) parts.push({ prompt: 'lesson-questions', role: 'teaching', count: 1, input: passageTokens, output: passageTokens })
    if (!lesson?.explanation && !done) parts.push({ prompt: 'lesson-explain', role: 'teaching', count: 1, input: passageTokens, output: passageTokens })
    const grades = done ? 0 : Math.max(0, USUAL_GRADED_ANSWERS - attempts.filter((a) => !a.skipped).length)
    if (grades > 0) parts.push({ prompt: 'grade', role: 'grading', count: grades, input: passageTokens + GRADED_TEXT_TOKENS, output: GRADED_TEXT_TOKENS })
    let calls = 0
    let input = 0
    let output = 0
    for (const part of parts) {
      const prompt = this.options.prompts.get(part.prompt)
      const f = this.options.providers.calibration(part.role, part.prompt)
      const weight = f.samples / (f.samples + 3)
      calls += part.count
      input += part.count * (textTokens(prompt.system) + textTokens(prompt.template) + part.input) * (1 + (f.inputFactor - 1) * weight)
      output += part.count * (prompt.outputBase + prompt.outputRatio * part.output) * (1 + (f.outputFactor - 1) * weight)
    }
    return this.estimateOf(model, calls, Math.round(input), Math.round(output))
  }
}
