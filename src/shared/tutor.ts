// Types for the diagnostic, standings, lessons and grades, shared by the main process and the renderer.

import type { SourceRef } from './citations'

export type Standing = 'known' | 'shaky' | 'new' | 'not-assessed'
export type Band = 'mastered' | 'known' | 'shaky' | 'new'
export type LessonStep = 'opening' | 'explain' | 'guided' | 'partial' | 'unaided' | 'done'
export type Verdict = 'correct' | 'partial' | 'incorrect'

export interface MasteryView {
  /** Probability the concept is known, 0 to 1. */
  p: number
  band: Band | null
  mastered: boolean
}

export interface ConceptStatus {
  id: number
  name: string
  definition: string
  mastery: MasteryView
  /** Locked until every prerequisite is mastered. */
  locked: boolean
  /** Names of prerequisites not yet mastered. */
  waitingFor: string[]
  lessonStep: LessonStep | null
}

export interface UnitStatus {
  id: number
  ordinal: number
  title: string
  /** False until the unit has been turned into concepts. */
  processed: boolean
  standing: Standing
  concepts: ConceptStatus[]
  mastered: number
  /** The learner's latest correction of this unit's standing. */
  override: { claimed: 'known' | 'new'; outcome: 'pending' | 'confirmed' | 'not-confirmed' | 'accepted' } | null
}

export interface CallEstimate {
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
}

export interface PathState {
  sessionId: number
  units: UnitStatus[]
  /** The earliest concept in syllabus order that is unlocked and not mastered. */
  next: { conceptId: number; name: string; unitTitle: string } | null
  diagnostic: { status: 'not-started' | 'in-progress' | 'done'; estimate: CallEstimate | null }
  /** A lesson that was left part way, to reopen where it stopped. */
  openLesson: { conceptId: number; name: string; step: LessonStep } | null
}

export interface McqQuestion {
  questionId: number
  conceptName: string
  stem: string
  choices: string[]
  /** 1-based position in the quiz, and the most questions it can have. */
  number: number
  max: number
}

export interface McqResult {
  conceptName: string
  stem: string
  choices: string[]
  answerIndex: number
  /** null when the learner chose "I don't know". */
  chosen: number | null
  why: string
}

export interface DiagnosticState {
  id: number
  kind: 'diagnostic' | 'confirm'
  unitTitle: string | null
  status: 'in-progress' | 'done'
  question: McqQuestion | null
  /** Answers so far, shown at the end. */
  results: McqResult[]
  /** For a confirming check: whether the claim was confirmed. */
  outcome: 'confirmed' | 'not-confirmed' | null
}

export interface CriterionView {
  id: string
  text: string
  points: number
  essential: boolean
  met: 'yes' | 'partly' | 'no'
  evidence: string
}

export interface GradeView {
  pass: 1 | 2
  verdict: Verdict
  score: number
  reason: string
  feedback: string
  criteria: CriterionView[]
  /** Citations like "S1 p. 12". */
  pages: string[]
  outsideSources: boolean
  objection: string | null
  /** The second grade's answer to the objection. */
  assessment: string | null
  gradedBy: 'model' | 'local'
  createdAt: string
}

export interface AttemptView {
  id: number
  answer: string
  skipped: boolean
  /** 'saved': kept, not graded yet. */
  status: 'saved' | 'graded' | 'failed'
  error: string | null
  grades: GradeView[]
  /** A contest was sent and its second grade is not in yet. */
  contestPending: boolean
  canContest: boolean
  submittedAt: string
}

export interface LessonQuestionView {
  id: number
  kind: 'opening' | 'guided' | 'partial' | 'unaided'
  stem: string
  scaffold: string | null
  /** For unaided questions: 1, 2, 3 ... */
  number: number
}

/** Why the lesson cannot go on by itself right now. */
export type LessonBlock = { kind: 'cap'; message: string; calls: number; callCap: number } | { kind: 'error'; message: string }

export interface LessonView {
  lessonId: number
  concept: { id: number; name: string; definition: string; unitTitle: string; prerequisites: string[] }
  step: LessonStep
  question: LessonQuestionView | null
  attempt: AttemptView | null
  draft: string
  explanation: { markdown: string; outsideSources: boolean } | null
  explaining: boolean
  /** The lesson's passages, to open cited pages. */
  sources: SourceRef[]
  /** True when the lesson's questions could not be based on the materials. */
  questionsOutsideSources: boolean
  mastery: MasteryView
  /** After the opening question: mastery is high enough to skip to an unaided question. */
  canFastTrack: boolean
  /** All unaided questions are answered and the concept is not mastered: more can be written (one call). */
  canMoreQuestions: boolean
  /** Model calls a lesson usually makes, for the estimate shown before it starts. */
  estimate: CallEstimate
  blocked: LessonBlock | null
  next: { conceptId: number; name: string } | null
}

export interface StreamEvent {
  lessonId: number
  kind: 'text' | 'reset'
  text: string
}
