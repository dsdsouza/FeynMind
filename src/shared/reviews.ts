// Types for review scheduling, review sittings, exam priorities and progress, shared by the main
// process and the renderer.

import type { SourceRef } from './citations'
import type { AttemptView, CallEstimate } from './tutor'

/** Why something is recommended. Shown to the learner through reasonText. */
export type Reason =
  | { code: 'due'; overdueDays: number }
  | { code: 'lapsed' }
  | { code: 'exam'; exam: string; inDays: number; weightShare: number; weightsGiven: boolean; recallOnExamDay: number | null; mastery: number | null }
  | { code: 'exam-prep' }
  | { code: 'syllabus' }
  | { code: 'interleave'; unitTitle: string }
  | { code: 'held'; limit: number }

const percent = (x: number): string => `${Math.round(x * 100)}%`

export function reasonText(r: Reason): string {
  switch (r.code) {
    case 'due':
      return r.overdueDays === 0 ? 'Due today' : `Overdue by ${r.overdueDays} day${r.overdueDays === 1 ? '' : 's'}`
    case 'lapsed':
      return 'Missed last time'
    case 'exam': {
      const when = r.inDays === 0 ? 'today' : r.inDays === 1 ? 'tomorrow' : `in ${r.inDays} days`
      const weight = r.weightsGiven ? `${percent(r.weightShare)} of the exam` : 'equal weight (the syllabus gives none)'
      const strength = r.recallOnExamDay !== null ? `predicted recall on the day ${percent(r.recallOnExamDay)}` : r.mastery !== null ? `mastery ${percent(r.mastery)}` : null
      return [`${r.exam} ${when}`, weight, strength].filter(Boolean).join(' · ')
    }
    case 'exam-prep':
      return 'Reviewed early for the exam'
    case 'syllabus':
      return 'Next in the syllabus'
    case 'interleave':
      return `Mixed in from an earlier topic (${r.unitTitle})`
    case 'held':
      return `Held for tomorrow (daily limit ${r.limit})`
  }
}

export const DEFAULT_DAILY_LIMIT = 25
export const MAX_DAILY_LIMIT = 200

/** A review planned for today, with why. */
export interface PlannedReview {
  conceptId: number
  name: string
  unitTitle: string
  reasons: Reason[]
}

/** The exam that is close, when one is: it changes what is recommended. */
export interface ExamFocus {
  examId: number
  title: string
  date: string
  inDays: number
  unitTitles: string[]
  weightsGiven: boolean
}

/** What is due today and how a sitting would go; all of it is read locally. */
export interface TodayState {
  sessionId: number
  /** Today's study day, 'YYYY-MM-DD' (days start at 04:00). */
  day: string
  /** Concepts due today or overdue, including any held back by the limit. */
  due: number
  /** What a sitting started now would review, in order. */
  planned: PlannedReview[]
  /** Due reviews beyond today's limit. */
  held: number
  /** When the backlog is cleared at the daily limit, if there is one. */
  catchUpDay: string | null
  limit: number
  answeredToday: number
  /** A sitting started today with reviews still to answer. */
  sitting: { id: number; remaining: number } | null
  /** The learner chose to skip the rest of today's reviews. */
  skippedToday: boolean
  /** New lessons wait until today's reviews are done or skipped. */
  lessonsWait: boolean
  estimate: ReviewEstimate
  examFocus: ExamFocus | null
  /** Answers saved but not graded yet (offline, or the cap was reached). */
  waitingGrades: number
  /** The computer's clock is behind the latest stored review; scheduling uses the later time. */
  clockBehind: boolean
}

export interface ReviewEstimate extends CallEstimate {
  grades: number
  /** Concepts that need new review questions written (one call each). */
  newQuestionSets: number
  /** Calls a re-teach adds if a review is missed and the re-teach is taken. */
  perReteach: number
}

export interface ReviewItemView {
  id: number
  conceptId: number
  conceptName: string
  /** Shown once the item is answered: naming the concept before would give the answer away. */
  unitTitle: string
  reasons: Reason[]
  status: 'pending' | 'answered'
  question: { id: number; stem: string; hasHint: boolean } | null
  /** The hint, once asked for (asking counts as help). */
  hint: string | null
  draft: string
  draftReasoning: string
  attempt: AttemptView | null
  /** Rated Again: a short re-teach is offered. */
  lapsed: boolean
  reteach: { markdown: string; outsideSources: boolean } | null
  reteaching: boolean
  reteachQuestion: { id: number; stem: string } | null
  reteachAttempt: AttemptView | null
  /** After a missed re-teach check: the lesson's own explanation, stored, shown without a call. */
  lessonExplanation: string | null
  sources: SourceRef[]
  /** Next due study day once graded. */
  nextDue: string | null
  error: string | null
}

export interface SittingView {
  id: number
  sessionId: number
  day: string
  status: 'open' | 'done'
  items: ReviewItemView[]
  /** A sitting that could not start every item (questions could not be written, for example). */
  blocked: { kind: 'cap' | 'error'; message: string } | null
}

export interface ReviewStreamEvent {
  itemId: number
  kind: 'text' | 'reset'
  text: string
}

/** The earlier-concept question mixed into a lesson. */
export interface InterleaveView {
  itemId: number
  stem: string
  reasons: Reason[]
  draft: string
  attempt: AttemptView | null
  /** Named once answered. */
  conceptName: string | null
}

export interface RecallMetric {
  name: '7 days' | '30 days'
  /** Days after first learning that count, inclusive. */
  from: number
  to: number
  /** Concepts with a review in the window, and how many were recalled (rated Good). */
  measured: number
  recalled: number
}

export interface ConceptProgress {
  conceptId: number
  name: string
  unitTitle: string
  state: 'learning' | 'scheduled' | 'lapsed'
  learnedDay: string | null
  lastDay: string | null
  dueDay: string | null
  recallNow: number | null
  stability: number | null
  reviews: number
  lapses: number
}

export interface ProgressView {
  sessionId: number
  day: string
  recall: RecallMetric[]
  /** The last 30 study days, oldest first. */
  daily: { day: string; reviews: number; recalled: number }[]
  /** Reviews falling due on each of the next 14 days, today first (today includes overdue). */
  forecast: { day: string; due: number }[]
  concepts: ConceptProgress[]
}

export interface DevClockState {
  enabled: boolean
  /** Today's study day as the app sees it. */
  day: string
  offsetDays: number
}
