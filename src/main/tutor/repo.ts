import type Database from 'better-sqlite3'
import type { LessonStep, ReasoningJudgment, Verdict } from '../../shared/tutor'
import type { Passage } from './passages'
import type { Criterion, CriterionResult } from './schemas'

// Database access for the tutor: questions, lessons, the diagnostic, answers and grades.

export type QuestionKind = 'diagnostic' | 'opening' | 'guided' | 'partial' | 'unaided'

export interface QuestionRow {
  id: number
  sessionId: number
  conceptId: number
  kind: QuestionKind
  ordinal: number
  stem: string
  choices: string[] | null
  answerIndex: number | null
  explanation: string | null
  referenceAnswer: string | null
  criteria: Criterion[]
  scaffold: string | null
  pages: string[]
  sources: Passage[]
  outsideSources: boolean
  /** 'lesson' for the lesson's own questions; 'review' for review variants (stored as unaided questions). */
  purpose: 'lesson' | 'review'
  /** For review variants: a one-line nudge that does not give the answer. */
  hint: string | null
}

export interface NewQuestion {
  kind: QuestionKind
  stem: string
  choices?: string[]
  answerIndex?: number
  explanation?: string
  referenceAnswer?: string
  criteria?: Criterion[]
  scaffold?: string | null
  pages: string[]
  sources: Passage[]
  outsideSources: boolean
  purpose?: 'lesson' | 'review'
  hint?: string | null
}

export interface LessonRow {
  id: number
  sessionId: number
  conceptId: number
  step: LessonStep
  questionId: number | null
  /** When the current question was first shown. */
  questionShownAt: string | null
  passages: Passage[]
  explanation: string | null
  explanationOutside: boolean
  draft: string
  draftReasoning: string
  startedAt: string
  updatedAt: string
  finishedAt: string | null
}

export interface AttemptRow {
  id: number
  sessionId: number
  conceptId: number
  questionId: number
  lessonId: number | null
  diagnosticId: number | null
  answer: string
  /** The learner's reasoning ("Your thinking"); '' when none was given. */
  reasoning: string
  choiceIndex: number | null
  skipped: boolean
  shownAt: string
  submittedAt: string
  status: 'saved' | 'graded' | 'failed'
  error: string | null
  objection: string | null
  objectionAt: string | null
  /**
   * 'lesson' for the lesson's own answers. Review and re-teach answers are attached to the
   * reviewed concept's lesson too (the shipped CHECK on attempts needs a lesson or a diagnostic),
   * so lesson code reads only purpose 'lesson'.
   */
  purpose: 'lesson' | 'review' | 'reteach'
  hintUsed: boolean
  reviewItemId: number | null
}

export interface GradeRow {
  id: number
  attemptId: number
  pass: 1 | 2
  verdict: Verdict
  score: number
  criteria: CriterionResult[]
  reason: string
  feedback: string
  pages: string[]
  outsideSources: boolean
  objection: string | null
  assessment: string | null
  reasoningJudgment: ReasoningJudgment | null
  reasoningComment: string | null
  gradedBy: 'model' | 'local'
  model: string | null
  createdAt: string
}

export interface NewGrade {
  pass: 1 | 2
  verdict: Verdict
  score: number
  criteria: CriterionResult[]
  reason: string
  feedback: string
  pages: string[]
  outsideSources: boolean
  objection?: string | null
  assessment?: string | null
  reasoningJudgment?: ReasoningJudgment | null
  reasoningComment?: string | null
  gradedBy: 'model' | 'local'
  model?: string | null
  promptVersion?: number | null
  cacheKey?: string | null
}

export interface DiagnosticRow {
  id: number
  sessionId: number
  kind: 'diagnostic' | 'confirm'
  unitId: number | null
  status: 'in-progress' | 'done' | 'abandoned'
  startedAt: string
}

const QUESTION_COLUMNS = `id, session_id AS sessionId, concept_id AS conceptId, kind, ordinal, stem, choices, answer_index AS answerIndex,
  explanation, reference_answer AS referenceAnswer, criteria, scaffold, pages, sources, outside_sources AS outsideSources, purpose, hint`
const LESSON_COLUMNS = `id, session_id AS sessionId, concept_id AS conceptId, step, question_id AS questionId, question_shown_at AS questionShownAt, passages, explanation,
  explanation_outside AS explanationOutside, draft_answer AS draft, draft_reasoning AS draftReasoning, started_at AS startedAt, updated_at AS updatedAt, finished_at AS finishedAt`
const ATTEMPT_COLUMNS = `id, session_id AS sessionId, concept_id AS conceptId, question_id AS questionId, lesson_id AS lessonId,
  diagnostic_id AS diagnosticId, answer_text AS answer, reasoning_text AS reasoning, choice_index AS choiceIndex, skipped, shown_at AS shownAt,
  submitted_at AS submittedAt, status, error, objection, objection_at AS objectionAt, purpose, hint_used AS hintUsed, review_item_id AS reviewItemId`
const GRADE_COLUMNS = `id, attempt_id AS attemptId, pass, verdict, score, criteria, reason, feedback, pages, outside_sources AS outsideSources,
  objection, assessment, reasoning_judgment AS reasoningJudgment, reasoning_comment AS reasoningComment, graded_by AS gradedBy, model, created_at AS createdAt`
const DIAGNOSTIC_COLUMNS = 'id, session_id AS sessionId, kind, unit_id AS unitId, status, started_at AS startedAt'

type RawQuestion = Omit<QuestionRow, 'choices' | 'criteria' | 'pages' | 'sources' | 'outsideSources'> & {
  choices: string | null
  criteria: string
  pages: string
  sources: string
  outsideSources: number
}
type RawLesson = Omit<LessonRow, 'passages' | 'explanationOutside'> & { passages: string; explanationOutside: number }
type RawAttempt = Omit<AttemptRow, 'skipped' | 'hintUsed'> & { skipped: number; hintUsed: number }
type RawGrade = Omit<GradeRow, 'criteria' | 'pages' | 'outsideSources'> & { criteria: string; pages: string; outsideSources: number }

const toQuestion = (r: RawQuestion): QuestionRow => ({
  ...r,
  choices: r.choices === null ? null : (JSON.parse(r.choices) as string[]),
  criteria: JSON.parse(r.criteria) as Criterion[],
  pages: JSON.parse(r.pages) as string[],
  sources: JSON.parse(r.sources) as Passage[],
  outsideSources: r.outsideSources === 1
})
const toLesson = (r: RawLesson): LessonRow => ({ ...r, passages: JSON.parse(r.passages) as Passage[], explanationOutside: r.explanationOutside === 1 })
const toAttempt = (r: RawAttempt): AttemptRow => ({ ...r, skipped: r.skipped === 1, hintUsed: r.hintUsed === 1 })
const toGrade = (r: RawGrade): GradeRow => ({
  ...r,
  criteria: JSON.parse(r.criteria) as CriterionResult[],
  pages: JSON.parse(r.pages) as string[],
  outsideSources: r.outsideSources === 1
})

export class TutorRepo {
  constructor(readonly db: Database.Database) {}

  // Questions

  /** Stores generated questions after any already stored for the same concept and kind. Returns their ids in order. */
  addQuestions(sessionId: number, conceptId: number, questions: NewQuestion[], prompt: { name: string; version: number; cacheKey: string }): number[] {
    return this.db.transaction(() =>
      questions.map((q) => {
        const ordinal =
          this.db.prepare<[number, string], { n: number | null }>('SELECT max(ordinal) AS n FROM questions WHERE concept_id = ? AND kind = ?').get(conceptId, q.kind)?.n ?? -1
        return Number(
          this.db
            .prepare(
              `INSERT INTO questions (session_id, concept_id, kind, ordinal, stem, choices, answer_index, explanation, reference_answer,
                 criteria, scaffold, pages, sources, outside_sources, prompt, prompt_version, cache_key, purpose, hint)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              sessionId,
              conceptId,
              q.kind,
              ordinal + 1,
              q.stem,
              q.choices ? JSON.stringify(q.choices) : null,
              q.answerIndex ?? null,
              q.explanation ?? null,
              q.referenceAnswer ?? null,
              JSON.stringify(q.criteria ?? []),
              q.scaffold ?? null,
              JSON.stringify(q.pages),
              JSON.stringify(q.sources),
              q.outsideSources ? 1 : 0,
              prompt.name,
              prompt.version,
              prompt.cacheKey,
              q.purpose ?? 'lesson',
              q.hint ?? null
            ).lastInsertRowid
        )
      })
    )()
  }

  getQuestion(id: number): QuestionRow | undefined {
    const row = this.db.prepare<[number], RawQuestion>(`SELECT ${QUESTION_COLUMNS} FROM questions WHERE id = ?`).get(id)
    return row ? toQuestion(row) : undefined
  }

  /** The concept's lesson and diagnostic questions (not review variants). */
  questionsOf(conceptId: number, kind?: QuestionKind): QuestionRow[] {
    const rows = kind
      ? this.db.prepare<[number, string], RawQuestion>(`SELECT ${QUESTION_COLUMNS} FROM questions WHERE concept_id = ? AND kind = ? AND purpose = 'lesson' ORDER BY ordinal`).all(conceptId, kind)
      : this.db.prepare<[number], RawQuestion>(`SELECT ${QUESTION_COLUMNS} FROM questions WHERE concept_id = ? AND purpose = 'lesson' ORDER BY kind, ordinal`).all(conceptId)
    return rows.map(toQuestion)
  }

  /** Questions a review can ask: the lesson's opening and unaided questions, and review variants. */
  reviewableQuestions(conceptId: number): QuestionRow[] {
    return this.db
      .prepare<[number], RawQuestion>(`SELECT ${QUESTION_COLUMNS} FROM questions WHERE concept_id = ? AND kind IN ('opening', 'unaided') ORDER BY id`)
      .all(conceptId)
      .map(toQuestion)
  }

  /** Every free-text question stem of the concept, so new questions can avoid repeating them. */
  stemsOf(conceptId: number): string[] {
    return this.db.prepare<[number], string>("SELECT stem FROM questions WHERE concept_id = ? AND kind != 'diagnostic' ORDER BY id").pluck().all(conceptId)
  }

  // Lessons

  lessonOfConcept(conceptId: number): LessonRow | undefined {
    const row = this.db.prepare<[number], RawLesson>(`SELECT ${LESSON_COLUMNS} FROM lessons WHERE concept_id = ?`).get(conceptId)
    return row ? toLesson(row) : undefined
  }

  getLesson(id: number): LessonRow | undefined {
    const row = this.db.prepare<[number], RawLesson>(`SELECT ${LESSON_COLUMNS} FROM lessons WHERE id = ?`).get(id)
    return row ? toLesson(row) : undefined
  }

  /** The lesson worked on most recently that is not finished, if any. */
  openLesson(sessionId: number): LessonRow | undefined {
    const row = this.db
      .prepare<[number], RawLesson>(`SELECT ${LESSON_COLUMNS} FROM lessons WHERE session_id = ? AND step != 'done' ORDER BY updated_at DESC, id DESC LIMIT 1`)
      .get(sessionId)
    return row ? toLesson(row) : undefined
  }

  lessonSteps(sessionId: number): Map<number, LessonStep> {
    const rows = this.db.prepare<[number], { conceptId: number; step: LessonStep }>('SELECT concept_id AS conceptId, step FROM lessons WHERE session_id = ?').all(sessionId)
    return new Map(rows.map((r) => [r.conceptId, r.step]))
  }

  createLesson(sessionId: number, conceptId: number, passages: Passage[]): LessonRow {
    this.db.prepare("INSERT INTO lessons (session_id, concept_id, step, passages) VALUES (?, ?, 'opening', ?)").run(sessionId, conceptId, JSON.stringify(passages))
    const lesson = this.lessonOfConcept(conceptId)
    if (!lesson) throw new Error('The lesson was not created.')
    return lesson
  }

  setLessonStep(id: number, step: LessonStep, questionId: number | null): void {
    this.db
      .prepare(
        `UPDATE lessons SET step = ?, question_id = ?, draft_answer = '', draft_reasoning = '', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           question_shown_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           finished_at = CASE WHEN ? = 'done' THEN coalesce(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE finished_at END
         WHERE id = ?`
      )
      .run(step, questionId, step, id)
  }

  saveExplanation(id: number, markdown: string, outside: boolean): void {
    this.db.prepare("UPDATE lessons SET explanation = ?, explanation_outside = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(markdown, outside ? 1 : 0, id)
  }

  saveDraft(id: number, field: 'answer' | 'reasoning', draft: string): void {
    const column = field === 'answer' ? 'draft_answer' : 'draft_reasoning'
    this.db.prepare(`UPDATE lessons SET ${column} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(draft, id)
  }

  clearDrafts(id: number): void {
    this.db.prepare("UPDATE lessons SET draft_answer = '', draft_reasoning = '', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id)
  }

  // Diagnostics

  createDiagnostic(sessionId: number, kind: 'diagnostic' | 'confirm', unitId: number | null): number {
    return Number(this.db.prepare("INSERT INTO diagnostics (session_id, kind, unit_id, status) VALUES (?, ?, ?, 'in-progress')").run(sessionId, kind, unitId).lastInsertRowid)
  }

  getDiagnostic(id: number): DiagnosticRow | undefined {
    return this.db.prepare<[number], DiagnosticRow>(`SELECT ${DIAGNOSTIC_COLUMNS} FROM diagnostics WHERE id = ?`).get(id)
  }

  /** The latest diagnostic or confirming check of the session, any status. */
  latestDiagnostic(sessionId: number, kind?: 'diagnostic' | 'confirm'): DiagnosticRow | undefined {
    return kind
      ? this.db.prepare<[number, string], DiagnosticRow>(`SELECT ${DIAGNOSTIC_COLUMNS} FROM diagnostics WHERE session_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`).get(sessionId, kind)
      : this.db.prepare<[number], DiagnosticRow>(`SELECT ${DIAGNOSTIC_COLUMNS} FROM diagnostics WHERE session_id = ? ORDER BY id DESC LIMIT 1`).get(sessionId)
  }

  finishDiagnostic(id: number, status: 'done' | 'abandoned'): void {
    this.db.prepare("UPDATE diagnostics SET status = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(status, id)
  }

  // Attempts and grades

  /** Saves an answer before it is graded. `submittedAt` defaults to the database's time. */
  addAttempt(a: {
    sessionId: number
    conceptId: number
    questionId: number
    lessonId: number | null
    diagnosticId: number | null
    answer: string
    reasoning?: string
    choiceIndex: number | null
    skipped: boolean
    shownAt: string
    submittedAt?: string
    purpose?: 'lesson' | 'review' | 'reteach'
    hintUsed?: boolean
    reviewItemId?: number | null
  }): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO attempts (session_id, concept_id, question_id, lesson_id, diagnostic_id, answer_text, reasoning_text, choice_index, skipped, shown_at, status,
             submitted_at, purpose, hint_used, review_item_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'saved', coalesce(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?, ?, ?)`
        )
        .run(
          a.sessionId,
          a.conceptId,
          a.questionId,
          a.lessonId,
          a.diagnosticId,
          a.answer,
          a.reasoning ?? '',
          a.choiceIndex,
          a.skipped ? 1 : 0,
          a.shownAt,
          a.submittedAt ?? null,
          a.purpose ?? 'lesson',
          a.hintUsed ? 1 : 0,
          a.reviewItemId ?? null
        ).lastInsertRowid
    )
  }

  getAttempt(id: number): AttemptRow | undefined {
    const row = this.db.prepare<[number], RawAttempt>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE id = ?`).get(id)
    return row ? toAttempt(row) : undefined
  }

  /** The lesson's own answers (not review or re-teach answers attached to it). */
  attemptsOfLesson(lessonId: number): AttemptRow[] {
    return this.db.prepare<[number], RawAttempt>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE lesson_id = ? AND purpose = 'lesson' ORDER BY id`).all(lessonId).map(toAttempt)
  }

  attemptsOfReviewItem(itemId: number): AttemptRow[] {
    return this.db.prepare<[number], RawAttempt>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE review_item_id = ? ORDER BY id`).all(itemId).map(toAttempt)
  }

  /** When each of a concept's questions was last answered (any purpose), for choosing a review question. */
  lastAnswered(conceptId: number): Map<number, string> {
    const rows = this.db
      .prepare<[number], { questionId: number; at: string }>('SELECT question_id AS questionId, max(submitted_at) AS at FROM attempts WHERE concept_id = ? GROUP BY question_id')
      .all(conceptId)
    return new Map(rows.map((r) => [r.questionId, r.at]))
  }

  attemptsOfDiagnostic(diagnosticId: number): AttemptRow[] {
    return this.db.prepare<[number], RawAttempt>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE diagnostic_id = ? ORDER BY id`).all(diagnosticId).map(toAttempt)
  }

  /**
   * Answers of the session still waiting for a grade, or for the second grade of a contest:
   * the lessons' own answers, or review and re-teach answers.
   */
  ungraded(sessionId: number, which: 'lesson' | 'review' = 'lesson'): AttemptRow[] {
    const purposes = which === 'lesson' ? "('lesson')" : "('review', 'reteach')"
    return this.db
      .prepare<[number], RawAttempt>(
        `SELECT ${ATTEMPT_COLUMNS} FROM attempts a WHERE session_id = ? AND lesson_id IS NOT NULL AND purpose IN ${purposes}
           AND (status = 'saved' OR (objection IS NOT NULL AND NOT EXISTS (SELECT 1 FROM grades g WHERE g.attempt_id = a.id AND g.pass = 2)))
         ORDER BY id`
      )
      .all(sessionId)
      .map(toAttempt)
  }

  setAttemptError(id: number, error: string | null): void {
    this.db.prepare('UPDATE attempts SET error = ? WHERE id = ?').run(error, id)
  }

  /** Saves a contest's objection before the second grading. */
  saveObjection(id: number, objection: string): void {
    this.db.prepare("UPDATE attempts SET objection = ?, objection_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), error = NULL WHERE id = ?").run(objection, id)
  }

  /** Stores a grade and, for the first grade, marks the answer graded, in one transaction. */
  addGrade(attemptId: number, g: NewGrade): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO grades (attempt_id, pass, verdict, score, criteria, reason, feedback, pages, outside_sources, objection, assessment,
             reasoning_judgment, reasoning_comment, graded_by, model, prompt_version, cache_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          attemptId,
          g.pass,
          g.verdict,
          g.score,
          JSON.stringify(g.criteria),
          g.reason,
          g.feedback,
          JSON.stringify(g.pages),
          g.outsideSources ? 1 : 0,
          g.objection ?? null,
          g.assessment ?? null,
          g.reasoningJudgment ?? null,
          g.reasoningComment ?? null,
          g.gradedBy,
          g.model ?? null,
          g.promptVersion ?? null,
          g.cacheKey ?? null
        )
      this.db.prepare("UPDATE attempts SET status = 'graded', error = NULL WHERE id = ?").run(attemptId)
    })()
  }

  grades(attemptId: number): GradeRow[] {
    return this.db.prepare<[number], RawGrade>(`SELECT ${GRADE_COLUMNS} FROM grades WHERE attempt_id = ? ORDER BY pass`).all(attemptId).map(toGrade)
  }

  /** The grade that counts: the second one after a contest, otherwise the first. */
  finalGrade(attemptId: number): GradeRow | undefined {
    const all = this.grades(attemptId)
    return all[all.length - 1]
  }

  // Unit overrides

  addOverride(sessionId: number, unitId: number, claimed: 'known' | 'new', diagnosticId: number | null, outcome: 'pending' | 'accepted'): number {
    return Number(
      this.db.prepare('INSERT INTO unit_overrides (session_id, unit_id, claimed, diagnostic_id, outcome) VALUES (?, ?, ?, ?, ?)').run(sessionId, unitId, claimed, diagnosticId, outcome).lastInsertRowid
    )
  }

  setOverrideOutcome(diagnosticId: number, outcome: 'confirmed' | 'not-confirmed'): void {
    this.db.prepare('UPDATE unit_overrides SET outcome = ? WHERE diagnostic_id = ?').run(outcome, diagnosticId)
  }

  overrideOfDiagnostic(diagnosticId: number): { unitId: number; outcome: string } | undefined {
    return this.db.prepare<[number], { unitId: number; outcome: string }>('SELECT unit_id AS unitId, outcome FROM unit_overrides WHERE diagnostic_id = ?').get(diagnosticId)
  }

  latestOverrides(sessionId: number): Map<number, { claimed: 'known' | 'new'; outcome: 'pending' | 'confirmed' | 'not-confirmed' | 'accepted' }> {
    const rows = this.db
      .prepare<[number], { unitId: number; claimed: 'known' | 'new'; outcome: 'pending' | 'confirmed' | 'not-confirmed' | 'accepted' }>(
        `SELECT unit_id AS unitId, claimed, outcome FROM unit_overrides o WHERE session_id = ?
           AND id = (SELECT max(id) FROM unit_overrides WHERE unit_id = o.unit_id)`
      )
      .all(sessionId)
    return new Map(rows.map((r) => [r.unitId, { claimed: r.claimed, outcome: r.outcome }]))
  }
}
