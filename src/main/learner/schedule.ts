import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from 'ts-fsrs'
import { addDays, dateToDay, daysBetween, dayToDate } from './days'

// Review scheduling with FSRS (ts-fsrs, FSRS-6 default weights). Each concept the learner has
// learned has a memory state (stability in days, difficulty) and a due study day. The state is
// always the replay of the concept's review events in order, with each event's rating worked out
// from the final grade, so a contested grade simply recomputes it, as mastery does.
//
// The scheduler only sees whole study days (see days.ts). Short-term learning steps are off: the
// lesson itself is the learning step. Fuzz is off, so due days are predictable and testable.

export const DESIRED_RETENTION = 0.9
export const MAX_INTERVAL_DAYS = 365

const scheduler = fsrs({ request_retention: DESIRED_RETENTION, maximum_interval: MAX_INTERVAL_DAYS, enable_fuzz: false, enable_short_term: false })

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy'
type Verdict = 'correct' | 'partial' | 'incorrect'
type ReasoningJudgment = 'sound' | 'flawed' | 'none'

const GRADE: Record<ReviewRating, Grade> = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy }

export interface ReviewOutcome {
  verdict: Verdict
  /** What the grader made of the reasoning; null when none was given. */
  reasoning: ReasoningJudgment | null
  hintUsed: boolean
  /** "I don't know". */
  skipped: boolean
}

/**
 * The rating of a review answer:
 * - Again: wrong or "I don't know"; flawed reasoning (a misconception should come back tomorrow
 *   with a re-teach, not drift to a longer interval); or partly right even with a hint.
 * - Hard: partly right without a hint, or right only with a hint. Hard is a pass in FSRS.
 * - Good: right without a hint, with sound reasoning or none given.
 * A review never gives Easy: grades measure correctness, not fluency, and a wrongly earned Easy
 * stretches the interval until the concept is forgotten.
 */
export function reviewRating(o: ReviewOutcome): ReviewRating {
  if (o.skipped || o.verdict === 'incorrect') return 'again'
  if (o.reasoning === 'flawed') return 'again'
  if (o.verdict === 'partial') return o.hintUsed ? 'again' : 'hard'
  return o.hintUsed ? 'hard' : 'good'
}

export interface LessonAnswer {
  kind: 'opening' | 'guided' | 'partial' | 'unaided'
  verdict: Verdict
}

/**
 * The rating of first learning, from the lesson's answers up to mastery:
 * - Easy: the opening question (asked before any teaching) was right and so was every later answer.
 * - Hard: an unaided answer was not fully right, or more than one of the guided, partial and
 *   unaided answers was not fully right.
 * - Good: otherwise. (A missed opening question is expected: it comes before the teaching.)
 */
export function learnedRating(answers: LessonAnswer[]): ReviewRating {
  const practice = answers.filter((a) => a.kind !== 'opening')
  const misses = practice.filter((a) => a.verdict !== 'correct')
  const opening = answers.find((a) => a.kind === 'opening')
  if (opening?.verdict === 'correct' && misses.length === 0) return 'easy'
  if (practice.some((a) => a.kind === 'unaided' && a.verdict !== 'correct') || misses.length > 1) return 'hard'
  return 'good'
}

/**
 * Delayed-recall windows (PRD success metrics): the first review 4 to 13 days after first learning
 * counts as recall at 7 days, the first 21 to 45 days after as recall at 30 days. FSRS alone often
 * steps over them (an all-Good path reviews on days 3, 17 and 74), so when the next review would
 * jump past a window that has no review yet, it is brought forward to the window's nominal day.
 */
export const RECALL_WINDOWS = [
  { name: '7 days', from: 4, to: 13, nominal: 7 },
  { name: '30 days', from: 21, to: 45, nominal: 30 }
] as const

export interface ScheduleEvent {
  day: string
  rating: ReviewRating
}

export interface CardState {
  /** Memory stability in days: the interval at which recall falls to 90%. */
  stability: number
  difficulty: number
  dueDay: string
  reps: number
  lapses: number
  lastDay: string
  learnedDay: string
  /** The last rating was Again. */
  lapsed: boolean
  /** The ts-fsrs card, for recall chances. */
  card: Card
}

/**
 * The memory state after a concept's events in order; the first is first learning. Days that go
 * backwards (a clock that moved back) count as the previous event's day. Null without events.
 */
export function replayCard(events: ScheduleEvent[]): CardState | null {
  const first = events[0]
  if (!first) return null
  const learnedDay = first.day
  let card = createEmptyCard(dayToDate(learnedDay))
  let lastDay = learnedDay
  let lapsed = false
  const reviewedSince: number[] = []
  events.forEach((e, i) => {
    const day = daysBetween(lastDay, e.day) < 0 ? lastDay : e.day
    card = scheduler.next(card, dayToDate(day), GRADE[e.rating]).card
    lastDay = day
    lapsed = e.rating === 'again'
    if (i > 0) reviewedSince.push(daysBetween(learnedDay, day))
    let due = dateToDay(card.due)
    // After a lapse the concept comes back the next study day, with the lowered memory state.
    if (lapsed) due = addDays(day, 1)
    const since = daysBetween(learnedDay, day)
    const dueSince = daysBetween(learnedDay, due)
    const window = RECALL_WINDOWS.find((w) => since < w.from && dueSince > w.to && !reviewedSince.some((d) => d >= w.from && d <= w.to))
    if (window) due = addDays(learnedDay, window.nominal)
    card = { ...card, due: dayToDate(due), scheduled_days: daysBetween(day, due) }
  })
  return { stability: card.stability, difficulty: card.difficulty, dueDay: dateToDay(card.due), reps: card.reps, lapses: card.lapses, lastDay, learnedDay, lapsed, card }
}

/** The chance of recalling the concept on a study day, from its memory state (1 on the day it was last reviewed). */
export function recallChance(state: Pick<CardState, 'card' | 'lastDay'>, day: string): number {
  if (daysBetween(state.lastDay, day) <= 0) return 1
  return scheduler.get_retrievability(state.card, dayToDate(day), false)
}

/** A card rebuilt from stored fields, for recall chances. */
export function storedCard(fields: { stability: number; difficulty: number; dueDay: string; lastDay: string; reps: number; lapses: number }): Card {
  return {
    due: dayToDate(fields.dueDay),
    stability: fields.stability,
    difficulty: fields.difficulty,
    elapsed_days: 0,
    scheduled_days: daysBetween(fields.lastDay, fields.dueDay),
    learning_steps: 0,
    reps: fields.reps,
    lapses: fields.lapses,
    state: State.Review,
    last_review: dayToDate(fields.lastDay)
  }
}
