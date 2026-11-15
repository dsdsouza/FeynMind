import type Database from 'better-sqlite3'
import type { ExamInfo } from '../../shared/knowledge'
import {
  DEFAULT_DAILY_LIMIT,
  MAX_DAILY_LIMIT,
  type ConceptProgress,
  type InterleaveView,
  type ProgressView,
  type Reason,
  type ReviewEstimate,
  type ReviewItemView,
  type ReviewStreamEvent,
  type SittingView,
  type TodayState
} from '../../shared/reviews'
import type { AppClock, KeyValue } from '../clock'
import { textTokens, type PromptLibrary } from '../knowledge'
import {
  addDays,
  closeExam,
  daysBetween,
  examReason,
  planReviews,
  RECALL_WINDOWS,
  recallChance,
  reviewRating,
  storedCard,
  studyDay,
  type LearnerRepo,
  type QueueCard,
  type ReviewCard
} from '../learner'
import { PauseError, ProviderError, UserFacingError, type ModelTask, type ModelTaskResult, type Role } from '../providers'
import { LESSON_BUDGET, sourceRefs, type Passage } from './passages'
import type { AttemptRow, LessonRow, QuestionRow, TutorRepo } from './repo'
import type { ConceptBrief, TaskContext } from './tasks'
import { reteachTask, reviewQuestionsTask } from './tasks'

// Review sittings, review questions, the re-teach after a lapse, the question from an earlier
// concept mixed into a lesson, and the progress view. Scheduling itself is the learner module's;
// grading is the tutor service's, shared with lessons.

/** Answers to the same question are not asked again within this many days if another question is available. */
export const QUESTION_COOLDOWN_DAYS = 7
/**
 * A question from an earlier concept is mixed into a lesson only when its recall chance is below
 * this: close to due, so the early review does not push a concept learned the day before (which
 * 0.97 did in the simulation) further out.
 */
export const INTERLEAVE_BELOW_RECALL = 0.93
const MAX_ANSWER = 5000
const MAX_OBJECTION = 2000
/** Tokens of a rubric, the question and a typed answer, as a grade request adds them to the passages. */
const GRADED_TEXT_TOKENS = 250
export const OFFLINE_PREFIX = 'offline: '
const OFFLINE_MESSAGE = 'Saved. It will be graded when you are back online.'
const CAP_PREFIX = 'cap: '
const RETRY_DELAYS_MS = [60_000, 120_000, 300_000]

export interface CourseConceptRef {
  id: number
  name: string
  definition: string
  prerequisites: number[]
  unitId: number
  unitTitle: string
}

/** What the review service needs from the tutor service that owns it. */
export interface ReviewHost {
  db: Database.Database
  repo: TutorRepo
  learner: LearnerRepo
  clock: AppClock
  settings: KeyValue
  prompts: PromptLibrary
  course(sessionId: number): { concepts: CourseConceptRef[]; unitIds: number[] }
  brief(concept: CourseConceptRef, all: CourseConceptRef[]): ConceptBrief
  ctx(sessionId: number, role: Role, prompt: string): TaskContext
  run<T>(sessionId: number, task: ModelTask<T>): Promise<T>
  runStream<T>(sessionId: number, task: ModelTask<T>, onText: (text: string) => void, onReset: () => void): Promise<ModelTaskResult<T>>
  startGrading(attemptId: number): void
  isGrading(attemptId: number): boolean
  consentGiven(sessionId: number): boolean
  exams(sessionId: number): ExamInfo[]
  isOnline(): boolean
  calibration(role: Role, prompt: string): { inputFactor: number; outputFactor: number; samples: number }
  costOf(model: string, tokens: { inputTokens: number; outputTokens: number }): number | null
  modelForRole(role: Role): string
  safeErrorMessage(error: unknown): string
  attemptView(attempt: AttemptRow, question: QuestionRow): ReviewItemView['attempt']
  onSitting(view: SittingView): void
  onLesson(lessonId: number): void
  onStream(event: ReviewStreamEvent): void
}

interface ItemRow {
  id: number
  sessionId: number
  sittingId: number | null
  lessonId: number | null
  conceptId: number
  ordinal: number
  questionId: number | null
  reasons: string
  status: 'pending' | 'answered'
  hintShown: number
  shownAt: string | null
  draft: string
  draftReasoning: string
  reteach: string | null
  reteachOutside: number
  reteachQuestionId: number | null
}

const ITEM_COLUMNS = `id, session_id AS sessionId, sitting_id AS sittingId, lesson_id AS lessonId, concept_id AS conceptId, ordinal, question_id AS questionId,
  reasons, status, hint_shown AS hintShown, shown_at AS shownAt, draft_answer AS draft, draft_reasoning AS draftReasoning, reteach,
  reteach_outside AS reteachOutside, reteach_question_id AS reteachQuestionId`

const limitKey = (sessionId: number) => `reviews.dailyLimit.${sessionId}`
const skipKey = (sessionId: number) => `reviews.skipped.${sessionId}`

/** Whether an error means the provider could not be reached (rather than refused or failed). */
export function isOfflineError(error: unknown): boolean {
  if (error instanceof ProviderError) return error.kind === 'network' || error.kind === 'timeout'
  if (error instanceof PauseError) return error.reason === 'provider' && /reach|connection|network|in time/i.test(error.message)
  return false
}

export class ReviewService {
  private readonly reteaching = new Map<number, Promise<void>>()
  private readonly blocks = new Map<number, { kind: 'cap' | 'error'; message: string }>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryCount = 0

  constructor(private readonly host: ReviewHost) {}

  // Time

  private today(): string {
    return studyDay(this.host.clock.now(), this.host.clock.timeZone())
  }

  private nowIso(): string {
    const now = this.host.clock.now()
    this.host.clock.recordWrite(now)
    return new Date(now).toISOString()
  }

  // Settings

  dailyLimit(sessionId: number): number {
    const n = Number(this.host.settings.get(limitKey(sessionId)))
    return Number.isInteger(n) && n >= 1 && n <= MAX_DAILY_LIMIT ? n : DEFAULT_DAILY_LIMIT
  }

  setDailyLimit(sessionId: number, limit: number): TodayState {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DAILY_LIMIT) throw new UserFacingError(`The daily limit must be a whole number from 1 to ${MAX_DAILY_LIMIT}.`)
    this.host.settings.set(limitKey(sessionId), String(limit))
    return this.todayState(sessionId)
  }

  /** Lets lessons start today without finishing the reviews; they stay due. */
  skipToday(sessionId: number): TodayState {
    this.host.settings.set(skipKey(sessionId), this.today())
    return this.todayState(sessionId)
  }

  // What is due

  private queueCards(sessionId: number, day: string): { cards: QueueCard[]; concepts: Map<number, CourseConceptRef> } {
    const { concepts } = this.host.course(sessionId)
    const byId = new Map(concepts.map((c) => [c.id, c]))
    const pending = new Set(
      this.host.db
        .prepare<[number], number>("SELECT DISTINCT concept_id FROM attempts WHERE session_id = ? AND purpose = 'review' AND status = 'saved'")
        .pluck()
        .all(sessionId)
    )
    const doneToday = new Set(this.host.db.prepare<[number, string], number>('SELECT DISTINCT concept_id FROM review_events WHERE session_id = ? AND day = ?').pluck().all(sessionId, day))
    const cards: QueueCard[] = []
    for (const card of this.host.learner.cards(sessionId)) {
      const c = byId.get(card.conceptId)
      if (!c) continue
      cards.push({ card, unitId: c.unitId, unitTitle: c.unitTitle, pendingGrade: pending.has(c.id), doneToday: doneToday.has(c.id) })
    }
    return { cards, concepts: byId }
  }

  private answeredToday(sessionId: number, day: string): number {
    return Number(
      this.host.db
        .prepare("SELECT count(*) FROM review_items i JOIN review_sittings s ON s.id = i.sitting_id WHERE s.session_id = ? AND s.day = ? AND i.status = 'answered'")
        .pluck()
        .get(sessionId, day)
    )
  }

  private plan(sessionId: number) {
    const day = this.today()
    const { cards, concepts } = this.queueCards(sessionId, day)
    const close = closeExam(this.host.exams(sessionId), day, this.host.course(sessionId).unitIds)
    const limit = this.dailyLimit(sessionId)
    const answered = this.answeredToday(sessionId, day)
    return { day, close, limit, answered, concepts, cards, plan: planReviews({ today: day, cards, close, limit, answeredToday: answered }) }
  }

  private openSitting(sessionId: number): { id: number; day: string } | undefined {
    return this.host.db.prepare<[number], { id: number; day: string }>("SELECT id, day FROM review_sittings WHERE session_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(sessionId)
  }

  private pendingIn(sittingId: number): number {
    return Number(this.host.db.prepare("SELECT count(*) FROM review_items WHERE sitting_id = ? AND status = 'pending'").pluck().get(sittingId))
  }

  todayState(sessionId: number): TodayState {
    const { day, close, limit, answered, concepts, plan } = this.plan(sessionId)
    const open = this.openSitting(sessionId)
    const sitting = open && open.day === day && this.pendingIn(open.id) > 0 ? { id: open.id, remaining: this.pendingIn(open.id) } : null
    const skippedToday = this.host.settings.get(skipKey(sessionId)) === day
    const dueLeft = plan.items.some((i) => i.reasons.some((r) => r.code === 'due')) || sitting !== null
    const behind = (this.host.clock as { behindMs?: () => number }).behindMs?.() ?? 0
    return {
      sessionId,
      day,
      due: plan.due,
      planned: plan.items.map((i) => ({ conceptId: i.conceptId, name: concepts.get(i.conceptId)?.name ?? '?', unitTitle: i.unitTitle, reasons: i.reasons })),
      held: plan.held,
      catchUpDay: plan.catchUpDay,
      limit,
      answeredToday: answered,
      sitting,
      skippedToday,
      lessonsWait: dueLeft && !skippedToday,
      estimate: this.estimate(sessionId, plan.items.map((i) => i.conceptId)),
      examFocus: close
        ? {
            examId: close.exam.id,
            title: close.exam.title,
            date: close.exam.date,
            inDays: close.inDays,
            unitTitles: close.exam.units.length > 0 ? close.exam.units.map((u) => u.title) : ['the whole course'],
            weightsGiven: close.weightsGiven
          }
        : null,
      waitingGrades: this.host.repo.ungraded(sessionId, 'review').filter((a) => a.status === 'saved').length,
      clockBehind: behind > 0
    }
  }

  /** Whether new lessons wait for today's reviews. */
  lessonsWait(sessionId: number): boolean {
    return this.todayState(sessionId).lessonsWait
  }

  // Questions

  /**
   * The question to ask in a review: never the one asked at the concept's previous review, nor
   * one answered in the last week; never-answered questions first, then the one answered longest
   * ago. 'generate' when none is eligible and new ones can be written.
   */
  private chooseQuestion(conceptId: number, exclude: number[] = []): QuestionRow | 'generate' {
    const pool = this.host.repo.reviewableQuestions(conceptId).filter((q) => !exclude.includes(q.id))
    const last = this.host.repo.lastAnswered(conceptId)
    const previous = this.previousReviewQuestion(conceptId)
    const cutoff = this.host.clock.now() - QUESTION_COOLDOWN_DAYS * 86_400_000
    const eligible = pool.filter((q) => q.id !== previous && (!last.has(q.id) || Date.parse(last.get(q.id) ?? '') < cutoff))
    const ranked = eligible.sort((a, b) => (last.get(a.id) ?? '').localeCompare(last.get(b.id) ?? '') || a.id - b.id)
    return ranked[0] ?? 'generate'
  }

  /** When new questions cannot be written (offline, cap): the question seen longest ago, avoiding the previous review's. */
  private fallbackQuestion(conceptId: number, exclude: number[] = []): QuestionRow | null {
    const pool = this.host.repo.reviewableQuestions(conceptId).filter((q) => !exclude.includes(q.id))
    const last = this.host.repo.lastAnswered(conceptId)
    const previous = this.previousReviewQuestion(conceptId)
    const ranked = pool.sort((a, b) => Number(a.id === previous) - Number(b.id === previous) || (last.get(a.id) ?? '').localeCompare(last.get(b.id) ?? '') || a.id - b.id)
    return ranked[0] ?? null
  }

  private previousReviewQuestion(conceptId: number): number | null {
    return this.host.db.prepare<[number], number>("SELECT question_id FROM attempts WHERE concept_id = ? AND purpose = 'review' ORDER BY id DESC LIMIT 1").pluck().get(conceptId) ?? null
  }

  /** Writes three review variants from the lesson's passages (one call, cached). */
  private async writeVariants(sessionId: number, conceptId: number): Promise<number[]> {
    const lesson = this.host.repo.lessonOfConcept(conceptId)
    const { concepts } = this.host.course(sessionId)
    const concept = concepts.find((c) => c.id === conceptId)
    if (!lesson || !concept) throw new UserFacingError('This concept has no lesson to write review questions from.')
    const prompt = this.host.prompts.get('review-questions')
    const asked = this.host.repo.stemsOf(conceptId)
    const task = reviewQuestionsTask(prompt, this.host.brief(concept, concepts), lesson.passages, asked, this.host.ctx(sessionId, 'teaching', prompt.name))
    const result = await this.host.run(sessionId, task)
    return this.host.repo.addQuestions(
      sessionId,
      conceptId,
      result.questions.map((q) => ({
        kind: 'unaided' as const,
        purpose: 'review' as const,
        stem: q.stem,
        referenceAnswer: q.referenceAnswer,
        criteria: q.criteria,
        hint: q.hint,
        scaffold: null,
        pages: q.pages,
        sources: lesson.passages,
        outsideSources: !result.covered
      })),
      { name: prompt.name, version: prompt.version, cacheKey: task.contentKey }
    )
  }

  /** A question for an item: chosen, written when needed and possible, or the fallback. */
  private async questionFor(sessionId: number, conceptId: number, exclude: number[], problems: string[]): Promise<number | null> {
    const chosen = this.chooseQuestion(conceptId, exclude)
    if (chosen !== 'generate') return chosen.id
    if (this.host.isOnline()) {
      try {
        const ids = await this.writeVariants(sessionId, conceptId)
        const fresh = ids.find((id) => !exclude.includes(id))
        if (fresh !== undefined) return fresh
      } catch (error) {
        problems.push(this.host.safeErrorMessage(error))
      }
    }
    return this.fallbackQuestion(conceptId, exclude)?.id ?? null
  }

  // Sittings

  /** Starts today's sitting (or returns the one in progress): the planned reviews, in mixed order, each with its question. */
  async start(sessionId: number): Promise<SittingView> {
    const day = this.today()
    const open = this.openSitting(sessionId)
    if (open && open.day === day && this.pendingIn(open.id) > 0) return this.sittingView(open.id)
    if (!this.host.consentGiven(sessionId)) throw new UserFacingError('Confirm the notice about sending course material first.')
    const { plan } = this.plan(sessionId)
    if (plan.items.length === 0) throw new UserFacingError('Nothing is due right now.')
    const now = this.nowIso()
    const sittingId = this.host.db.transaction(() => {
      // A sitting left open on an earlier day is closed; what it did not reach is still due.
      this.host.db.prepare("UPDATE review_sittings SET status = 'done', finished_at = ? WHERE session_id = ? AND status = 'open'").run(now, sessionId)
      this.host.db.prepare("DELETE FROM review_items WHERE status = 'pending' AND sitting_id IN (SELECT id FROM review_sittings WHERE session_id = ? AND finished_at = ?)").run(sessionId, now)
      const id = Number(this.host.db.prepare("INSERT INTO review_sittings (session_id, day, status, started_at) VALUES (?, ?, 'open', ?)").run(sessionId, day, now).lastInsertRowid)
      plan.items.forEach((item, i) => {
        this.host.db
          .prepare("INSERT INTO review_items (session_id, sitting_id, concept_id, ordinal, reasons, status) VALUES (?, ?, ?, ?, ?, 'pending')")
          .run(sessionId, id, item.conceptId, i, JSON.stringify(item.reasons))
      })
      return id
    })()
    const problems: string[] = []
    for (const item of this.items(sittingId)) {
      const questionId = await this.questionFor(sessionId, item.conceptId, [], problems)
      this.host.db.prepare('UPDATE review_items SET question_id = ? WHERE id = ?').run(questionId, item.id)
    }
    if (problems.length > 0) this.blocks.set(sittingId, { kind: 'error', message: `New review questions could not be written, so some questions are ones you have seen before. (${problems[0]})` })
    return this.sittingView(sittingId)
  }

  /** Today's sitting with reviews still to answer, or the last one of today. */
  current(sessionId: number): SittingView | null {
    const row = this.host.db.prepare<[number], { id: number; day: string }>('SELECT id, day FROM review_sittings WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId)
    return row && row.day === this.today() ? this.sittingView(row.id) : null
  }

  private items(sittingId: number): ItemRow[] {
    return this.host.db.prepare<[number], ItemRow>(`SELECT ${ITEM_COLUMNS} FROM review_items WHERE sitting_id = ? ORDER BY ordinal`).all(sittingId)
  }

  private item(itemId: number): ItemRow {
    const row = this.host.db.prepare<[number], ItemRow>(`SELECT ${ITEM_COLUMNS} FROM review_items WHERE id = ?`).get(itemId)
    if (!row) throw new UserFacingError('That review no longer exists.')
    return row
  }

  /** Marks the moment a question is first shown (for the answer's shown time). */
  shown(itemId: number): void {
    this.host.db.prepare('UPDATE review_items SET shown_at = coalesce(shown_at, ?) WHERE id = ?').run(this.nowIso(), itemId)
  }

  showHint(itemId: number): SittingView | null {
    const item = this.item(itemId)
    if (item.status !== 'pending') throw new UserFacingError('That review is already answered.')
    this.host.db.prepare('UPDATE review_items SET hint_shown = 1 WHERE id = ?').run(itemId)
    return this.notify(item)
  }

  saveDraft(itemId: number, field: 'answer' | 'reasoning', text: string): void {
    const column = field === 'answer' ? 'draft_answer' : 'draft_reasoning'
    this.host.db.prepare(`UPDATE review_items SET ${column} = ? WHERE id = ?`).run(text.slice(0, MAX_ANSWER), this.item(itemId).id)
  }

  /** Saves a review answer (before any grading) and grades it, or grades "I don't know" here. */
  answer(itemId: number, text: string, skipped: boolean, reasoningText = ''): SittingView | null {
    const item = this.item(itemId)
    if (item.status !== 'pending') throw new UserFacingError('That review is already answered.')
    if (item.questionId === null) throw new UserFacingError('This review has no question yet. Try again when you are online.')
    const { answer, reasoning } = this.checkAnswer(text, skipped, reasoningText)
    const lesson = this.lessonOf(item.conceptId)
    const now = this.nowIso()
    const attemptId = this.host.db.transaction(() => {
      const id = this.host.repo.addAttempt({
        sessionId: item.sessionId,
        conceptId: item.conceptId,
        questionId: item.questionId as number,
        lessonId: lesson.id,
        diagnosticId: null,
        answer,
        reasoning,
        choiceIndex: null,
        skipped,
        shownAt: item.shownAt ?? now,
        submittedAt: now,
        purpose: 'review',
        hintUsed: item.hintShown === 1,
        reviewItemId: item.id
      })
      this.host.db.prepare("UPDATE review_items SET status = 'answered', draft_answer = '', draft_reasoning = '' WHERE id = ?").run(item.id)
      this.host.learner.recordReview(item.sessionId, item.conceptId, id, now)
      if (skipped) this.gradeLocally(id, item.sessionId, item.conceptId)
      if (item.sittingId !== null && this.pendingIn(item.sittingId) === 0) {
        this.host.db.prepare("UPDATE review_sittings SET status = 'done', finished_at = ? WHERE id = ?").run(now, item.sittingId)
      }
      return id
    })()
    if (!skipped) this.host.startGrading(attemptId)
    return this.notify(item)
  }

  private checkAnswer(text: string, skipped: boolean, reasoningText: string): { answer: string; reasoning: string } {
    const answer = skipped ? '' : text.trim()
    if (!skipped && answer === '') throw new UserFacingError('Type an answer, or choose "I don\'t know".')
    if (answer.length > MAX_ANSWER) throw new UserFacingError(`Keep the answer under ${MAX_ANSWER} characters.`)
    const reasoning = skipped ? '' : reasoningText.trim()
    if (reasoning.length > MAX_ANSWER) throw new UserFacingError(`Keep your thinking under ${MAX_ANSWER} characters.`)
    return { answer, reasoning }
  }

  private gradeLocally(attemptId: number, sessionId: number, conceptId: number): void {
    this.host.repo.addGrade(attemptId, {
      pass: 1,
      verdict: 'incorrect',
      score: 0,
      criteria: [],
      reason: 'You chose "I don\'t know". That is fine: it comes back soon, and a short re-teach is offered.',
      feedback: '',
      pages: [],
      outsideSources: false,
      gradedBy: 'local'
    })
    this.host.learner.addEvidence(sessionId, conceptId, 'answer', { attemptId })
  }

  private lessonOf(conceptId: number): LessonRow {
    const lesson = this.host.repo.lessonOfConcept(conceptId)
    if (!lesson) throw new UserFacingError('This concept has no lesson.')
    return lesson
  }

  /** Contests a review or re-teach grade once, like a lesson grade. */
  contest(attemptId: number, objection: string): SittingView | null {
    const attempt = this.host.repo.getAttempt(attemptId)
    if (!attempt || attempt.purpose === 'lesson' || attempt.reviewItemId === null) throw new UserFacingError('That answer cannot be contested here.')
    const text = objection.trim()
    if (text === '') throw new UserFacingError('Say why you think the grade is wrong.')
    if (text.length > MAX_OBJECTION) throw new UserFacingError(`Keep the objection under ${MAX_OBJECTION} characters.`)
    if (attempt.skipped || attempt.status !== 'graded') throw new UserFacingError('Only a graded answer can be contested.')
    if (attempt.objection !== null) throw new UserFacingError('A grade can be contested only once.')
    this.host.repo.saveObjection(attempt.id, text)
    this.host.startGrading(attempt.id)
    return this.notify(this.item(attempt.reviewItemId))
  }

  // Re-teach

  private reviewAttempt(item: ItemRow): AttemptRow | undefined {
    return this.host.repo.attemptsOfReviewItem(item.id).find((a) => a.purpose === 'review')
  }

  private isLapse(attempt: AttemptRow | undefined): boolean {
    if (!attempt || attempt.status !== 'graded') return false
    const grade = this.host.repo.finalGrade(attempt.id)
    if (!grade) return false
    return reviewRating({ verdict: grade.verdict, reasoning: grade.reasoningJudgment, hintUsed: attempt.hintUsed, skipped: attempt.skipped }) === 'again'
  }

  /** Starts the short re-teach after a missed review (one call, streamed), and picks the question that checks it. */
  async reteach(itemId: number): Promise<SittingView | null> {
    const item = this.item(itemId)
    const attempt = this.reviewAttempt(item)
    if (!this.isLapse(attempt)) throw new UserFacingError('A re-teach is offered after a missed review.')
    if (item.reteach === null && !this.reteaching.has(item.id)) {
      const work = this.writeReteach(item, attempt as AttemptRow).finally(() => this.reteaching.delete(item.id))
      this.reteaching.set(item.id, work)
    }
    if (item.reteachQuestionId === null) {
      const problems: string[] = []
      const questionId = await this.questionFor(item.sessionId, item.conceptId, item.questionId === null ? [] : [item.questionId], problems)
      this.host.db.prepare('UPDATE review_items SET reteach_question_id = ? WHERE id = ?').run(questionId, item.id)
    }
    return this.notify(this.item(item.id))
  }

  private async writeReteach(item: ItemRow, attempt: AttemptRow): Promise<void> {
    try {
      const { concepts } = this.host.course(item.sessionId)
      const concept = concepts.find((c) => c.id === item.conceptId)
      const question = this.host.repo.getQuestion(attempt.questionId)
      const lesson = this.lessonOf(item.conceptId)
      if (!concept || !question) throw new UserFacingError('This concept is no longer part of a processed unit.')
      const grade = this.host.repo.finalGrade(attempt.id)
      const feedback = grade
        ? [`Verdict: ${grade.verdict}`, `Reason: ${grade.reason}`, grade.feedback ? `Feedback: ${grade.feedback}` : '', grade.reasoningComment ? `On the reasoning (${grade.reasoningJudgment}): ${grade.reasoningComment}` : '']
            .filter(Boolean)
            .join('\n')
        : 'Not graded.'
      const prompt = this.host.prompts.get('reteach')
      const task = reteachTask(
        prompt,
        this.host.brief(concept, concepts),
        lesson.passages,
        { question: question.stem, referenceAnswer: question.referenceAnswer ?? '', answer: attempt.answer, reasoning: attempt.reasoning, feedback },
        this.host.ctx(item.sessionId, 'teaching', prompt.name)
      )
      const result = await this.host.runStream(
        item.sessionId,
        task,
        (text) => this.host.onStream({ itemId: item.id, kind: 'text', text }),
        () => this.host.onStream({ itemId: item.id, kind: 'reset', text: '' })
      )
      this.host.db.prepare('UPDATE review_items SET reteach = ?, reteach_outside = ? WHERE id = ?').run(result.value.markdown, result.value.outsideSources ? 1 : 0, item.id)
      this.blocks.delete(item.sittingId ?? -item.id)
    } catch (error) {
      this.host.onStream({ itemId: item.id, kind: 'reset', text: '' })
      this.blocks.set(item.sittingId ?? -item.id, this.blockOf(error))
    }
    this.notify(this.item(item.id))
  }

  /** The answer to the question that checks the re-teach: counts toward mastery, not toward the schedule. */
  answerReteach(itemId: number, text: string, skipped: boolean, reasoningText = ''): SittingView | null {
    const item = this.item(itemId)
    if (item.reteachQuestionId === null) throw new UserFacingError('Start the re-teach first.')
    if (this.host.repo.attemptsOfReviewItem(item.id).some((a) => a.purpose === 'reteach')) throw new UserFacingError('That question was already answered.')
    const { answer, reasoning } = this.checkAnswer(text, skipped, reasoningText)
    const lesson = this.lessonOf(item.conceptId)
    const now = this.nowIso()
    const attemptId = this.host.db.transaction(() => {
      const id = this.host.repo.addAttempt({
        sessionId: item.sessionId,
        conceptId: item.conceptId,
        questionId: item.reteachQuestionId as number,
        lessonId: lesson.id,
        diagnosticId: null,
        answer,
        reasoning,
        choiceIndex: null,
        skipped,
        shownAt: now,
        submittedAt: now,
        purpose: 'reteach',
        reviewItemId: item.id
      })
      if (skipped) this.gradeLocally(id, item.sessionId, item.conceptId)
      return id
    })()
    if (!skipped) this.host.startGrading(attemptId)
    return this.notify(item)
  }

  // Grading results and offline answers

  /** Called by the tutor service after a review or re-teach answer was graded (or could not be). */
  afterGrading(attempt: AttemptRow): void {
    if (attempt.reviewItemId === null) return
    const item = this.item(attempt.reviewItemId)
    this.notify(item)
  }

  /** The error to store when grading a review answer did not happen; null to keep the tutor's own handling. */
  gradingError(error: unknown): string | null {
    if (!this.host.isOnline() || isOfflineError(error)) {
      this.scheduleRetry()
      return `${OFFLINE_PREFIX}${OFFLINE_MESSAGE}`
    }
    return null
  }

  /** Grades every review answer still waiting (at startup, when the connection returns, after the cap is raised). */
  resumePending(sessionId?: number): number {
    const sessions = sessionId !== undefined ? [sessionId] : this.host.db.prepare<[], number>('SELECT id FROM sessions').pluck().all()
    let started = 0
    for (const s of sessions) {
      for (const a of this.host.repo.ungraded(s, 'review')) {
        if (this.host.isGrading(a.id)) continue
        this.host.repo.setAttemptError(a.id, null)
        this.host.startGrading(a.id)
        started++
      }
    }
    if (started > 0) this.retryCount = 0
    return started
  }

  /** Called when the window says the connection is back. */
  online(): void {
    if (this.host.isOnline()) this.resumePending()
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return
    const delay = RETRY_DELAYS_MS[Math.min(this.retryCount, RETRY_DELAYS_MS.length - 1)] ?? 300_000
    this.retryCount++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.host.isOnline()) this.resumePending()
      else this.scheduleRetry()
    }, delay)
    this.retryTimer.unref?.()
  }

  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  /** Re-teaches being written, for waiting on them. */
  running(): Promise<void>[] {
    return [...this.reteaching.values()]
  }

  // Interleaving in lessons

  /**
   * The question from an earlier concept mixed into a lesson, between its partial and its first
   * unaided question: at most one per lesson, from a learned concept that is not lapsed, not due
   * today (due ones are in the review sitting) and not reviewed today, preferring another unit and
   * the lowest chance of recall, and only when that chance is below 93%. It is a real (early)
   * review. Null when there is none.
   */
  interleaveItem(lesson: LessonRow, create: boolean): ItemRow | null {
    const existing = this.host.db.prepare<[number], ItemRow>(`SELECT ${ITEM_COLUMNS} FROM review_items WHERE lesson_id = ?`).get(lesson.id)
    if (existing || !create) return existing ?? null
    const day = this.today()
    const { cards, concepts } = this.queueCards(lesson.sessionId, day)
    const own = concepts.get(lesson.conceptId)
    const candidates = cards
      .filter((c) => c.card.conceptId !== lesson.conceptId && !c.card.lapsed && !c.doneToday && !c.pendingGrade && daysBetween(day, c.card.dueDay) > 0)
      .filter((c) => !this.host.learner.get(c.card.conceptId).lapsed)
      .map((c) => ({ c, recall: recallChance({ card: storedCard(c.card), lastDay: c.card.lastDay }, day) }))
      .filter((x) => x.recall < INTERLEAVE_BELOW_RECALL)
      .sort((a, b) => Number(a.c.unitId === own?.unitId) - Number(b.c.unitId === own?.unitId) || a.recall - b.recall || a.c.card.conceptId - b.c.card.conceptId)
    const pick = candidates[0]
    if (!pick) return null
    const question = this.chooseQuestion(pick.c.card.conceptId)
    const fallback = question === 'generate' ? this.fallbackQuestion(pick.c.card.conceptId) : question
    if (!fallback) return null
    const reasons: Reason[] = [{ code: 'interleave', unitTitle: pick.c.unitTitle }]
    const id = Number(
      this.host.db
        .prepare("INSERT INTO review_items (session_id, lesson_id, concept_id, ordinal, question_id, reasons, status, shown_at) VALUES (?, ?, ?, 0, ?, ?, 'pending', ?)")
        .run(lesson.sessionId, lesson.id, pick.c.card.conceptId, fallback.id, JSON.stringify(reasons), this.nowIso()).lastInsertRowid
    )
    return this.item(id)
  }

  interleaveView(item: ItemRow): InterleaveView {
    const question = item.questionId === null ? undefined : this.host.repo.getQuestion(item.questionId)
    const attempt = this.reviewAttempt(item)
    const { concepts } = this.host.course(item.sessionId)
    return {
      itemId: item.id,
      stem: question?.stem ?? '',
      reasons: JSON.parse(item.reasons) as Reason[],
      draft: item.draft,
      attempt: attempt && question ? this.host.attemptView(attempt, question) : null,
      conceptName: item.status === 'answered' ? (concepts.find((c) => c.id === item.conceptId)?.name ?? null) : null
    }
  }

  // Views

  private notify(item: ItemRow): SittingView | null {
    if (item.lessonId !== null) {
      this.host.onLesson(item.lessonId)
      return null
    }
    const view = this.sittingView(item.sittingId as number)
    this.host.onSitting(view)
    return view
  }

  private blockOf(error: unknown): { kind: 'cap' | 'error'; message: string } {
    const message = this.host.safeErrorMessage(error)
    return error instanceof PauseError && error.reason === 'cap' ? { kind: 'cap', message } : { kind: 'error', message }
  }

  sittingView(sittingId: number): SittingView {
    const row = this.host.db.prepare<[number], { id: number; sessionId: number; day: string; status: 'open' | 'done' }>('SELECT id, session_id AS sessionId, day, status FROM review_sittings WHERE id = ?').get(sittingId)
    if (!row) throw new UserFacingError('That review sitting no longer exists.')
    const { concepts } = this.host.course(row.sessionId)
    const byId = new Map(concepts.map((c) => [c.id, c]))
    return { id: row.id, sessionId: row.sessionId, day: row.day, status: row.status, items: this.items(row.id).map((i) => this.itemView(i, byId)), blocked: this.blocks.get(row.id) ?? null }
  }

  private itemView(item: ItemRow, concepts: Map<number, CourseConceptRef>): ReviewItemView {
    const concept = concepts.get(item.conceptId)
    const question = item.questionId === null ? undefined : this.host.repo.getQuestion(item.questionId)
    const attempts = this.host.repo.attemptsOfReviewItem(item.id)
    const attempt = attempts.find((a) => a.purpose === 'review')
    const reteachAttempt = attempts.find((a) => a.purpose === 'reteach')
    const reteachQuestion = item.reteachQuestionId === null ? undefined : this.host.repo.getQuestion(item.reteachQuestionId)
    const lesson = this.host.repo.lessonOfConcept(item.conceptId)
    const reteachMissed = reteachAttempt?.status === 'graded' && this.host.repo.finalGrade(reteachAttempt.id)?.verdict !== 'correct'
    const card = this.host.learner.card(item.conceptId)
    const answered = item.status === 'answered'
    const error = attempt?.error ?? reteachAttempt?.error ?? null
    return {
      id: item.id,
      conceptId: item.conceptId,
      conceptName: answered ? (concept?.name ?? '?') : '',
      unitTitle: answered ? (concept?.unitTitle ?? '') : '',
      reasons: JSON.parse(item.reasons) as Reason[],
      status: item.status,
      question: question ? { id: question.id, stem: question.stem, hasHint: true } : null,
      hint: item.hintShown === 1 ? (question?.hint ?? `Remember the definition: ${concept?.definition ?? ''}`) : null,
      draft: item.draft,
      draftReasoning: item.draftReasoning,
      attempt: attempt && question ? this.host.attemptView(attempt, question) : null,
      lapsed: this.isLapse(attempt),
      reteach: item.reteach === null ? null : { markdown: item.reteach, outsideSources: item.reteachOutside === 1 },
      reteaching: this.reteaching.has(item.id),
      reteachQuestion: reteachQuestion ? { id: reteachQuestion.id, stem: reteachQuestion.stem } : null,
      reteachAttempt: reteachAttempt && reteachQuestion ? this.host.attemptView(reteachAttempt, reteachQuestion) : null,
      lessonExplanation: reteachMissed ? (lesson?.explanation ?? null) : null,
      sources: lesson ? sourceRefs(lesson.passages) : [],
      nextDue: attempt?.status === 'graded' ? (card?.dueDay ?? null) : null,
      error: error === null ? null : error.startsWith(OFFLINE_PREFIX) ? error.slice(OFFLINE_PREFIX.length) : error.startsWith(CAP_PREFIX) ? error.slice(CAP_PREFIX.length) : error
    }
  }

  // Estimates

  /** Calls a sitting reviewing these concepts usually makes: a grade each, and new questions where none is eligible. */
  estimate(sessionId: number, conceptIds: number[]): ReviewEstimate {
    const model = this.host.modelForRole('grading')
    let calls = 0
    let input = 0
    let output = 0
    let newQuestionSets = 0
    const add = (promptName: string, role: Role, count: number, variableIn: number, variableOut: number) => {
      const prompt = this.host.prompts.get(promptName)
      const f = this.host.calibration(role, promptName)
      const weight = f.samples / (f.samples + 3)
      calls += count
      input += count * (textTokens(prompt.system) + textTokens(prompt.template) + variableIn) * (1 + (f.inputFactor - 1) * weight)
      output += count * (prompt.outputBase + prompt.outputRatio * variableOut) * (1 + (f.outputFactor - 1) * weight)
    }
    for (const id of conceptIds) {
      const lesson = this.host.repo.lessonOfConcept(id)
      const passages = lesson ? lesson.passages.reduce((n, p: Passage) => n + textTokens(p.text) + 30, 0) : LESSON_BUDGET
      add('grade', 'grading', 1, passages + GRADED_TEXT_TOKENS, GRADED_TEXT_TOKENS)
      if (this.chooseQuestion(id) === 'generate') {
        newQuestionSets++
        add('review-questions', 'teaching', 1, passages, passages)
      }
    }
    const inputTokens = Math.round(input)
    const outputTokens = Math.round(output)
    return { calls, inputTokens, outputTokens, costUsd: this.host.costOf(model, { inputTokens, outputTokens }), grades: conceptIds.length, newQuestionSets, perReteach: 2 }
  }

  // Progress

  progress(sessionId: number): ProgressView {
    const day = this.today()
    const { concepts } = this.host.course(sessionId)
    const cards = new Map(this.host.learner.cards(sessionId).map((c) => [c.conceptId, c]))
    const recall = RECALL_WINDOWS.map((w) => ({ name: w.name, from: w.from, to: w.to, measured: 0, recalled: 0 }))
    const daily = new Map<string, { reviews: number; recalled: number }>()
    const conceptRows: ConceptProgress[] = []
    for (const c of concepts) {
      const card = cards.get(c.id)
      const events = card ? this.host.learner.scheduleEvents(c.id) : []
      const reviews = events.filter((e) => e.kind === 'review')
      if (card) {
        for (const w of recall) {
          const first = reviews.find((e) => {
            const since = daysBetween(card.learnedDay, e.day)
            return since >= w.from && since <= w.to
          })
          if (first) {
            w.measured++
            if (first.rating === 'good') w.recalled++
          }
        }
        for (const e of reviews) {
          const d = daily.get(e.day) ?? { reviews: 0, recalled: 0 }
          d.reviews++
          if (e.rating === 'good') d.recalled++
          daily.set(e.day, d)
        }
      }
      const m = this.host.learner.get(c.id)
      conceptRows.push({
        conceptId: c.id,
        name: c.name,
        unitTitle: c.unitTitle,
        state: !card ? 'learning' : m.lapsed ? 'lapsed' : 'scheduled',
        learnedDay: card?.learnedDay ?? null,
        lastDay: card?.lastDay ?? null,
        dueDay: card?.dueDay ?? null,
        recallNow: card ? recallOf(card, day) : null,
        stability: card?.stability ?? null,
        reviews: reviews.length,
        lapses: card?.lapses ?? 0
      })
    }
    const all = [...cards.values()].filter((c) => concepts.some((x) => x.id === c.conceptId))
    return {
      sessionId,
      day,
      recall,
      daily: Array.from({ length: 30 }, (_, i) => addDays(day, i - 29)).map((d) => ({ day: d, ...(daily.get(d) ?? { reviews: 0, recalled: 0 }) })),
      forecast: Array.from({ length: 14 }, (_, i) => addDays(day, i)).map((d, i) => ({ day: d, due: all.filter((c) => (i === 0 ? daysBetween(c.dueDay, d) >= 0 : c.dueDay === d)).length })),
      concepts: conceptRows
    }
  }

  /** Why the next lesson is recommended: an exam that is close, or the syllabus order. */
  lessonReasons(sessionId: number, unitId: number, p: number): Reason[] {
    const close = closeExam(this.host.exams(sessionId), this.today(), this.host.course(sessionId).unitIds)
    if (close && close.share.has(unitId)) return [examReason(close, unitId, { recallOnExamDay: null, mastery: p })]
    return [{ code: 'syllabus' }]
  }

  /** The close exam's units and shares, for choosing the next lesson. */
  closeExamShares(sessionId: number): Map<number, number> | null {
    return closeExam(this.host.exams(sessionId), this.today(), this.host.course(sessionId).unitIds)?.share ?? null
  }
}

function recallOf(card: ReviewCard, day: string): number {
  return recallChance({ card: storedCard(card), lastDay: card.lastDay }, day)
}
