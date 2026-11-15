import type { ExamInfo } from '../../shared/knowledge'
import type { Reason } from '../../shared/reviews'
import { addDays, daysBetween } from './days'
import type { ReviewCard } from './repo'
import { recallChance, storedCard } from './schedule'

// Choosing what to review today. Pure functions of the cards, the exams and today's study day.
//
// - Due: cards due today or earlier, leaving out concepts with an answer still waiting for its
//   grade and concepts already reviewed today.
// - Order: when an exam is close, due concepts in its units first (heaviest and weakest first),
//   then other due concepts by lowest chance of recall now, then early "exam prep" reviews of
//   concepts in the exam's units whose predicted recall on the exam day is below 90%.
// - Daily limit: the list is cut to what is left of today's limit. Due concepts beyond it are
//   held for tomorrow; overdue ones keep their due day, and FSRS uses the real time elapsed.
// - Mixing: the chosen reviews are put in an order that changes unit at every step when it can.

/** An exam is close from this many days before it, up to its day. */
export const EXAM_WINDOW_DAYS = 14
/** Early review for an exam when predicted recall on the exam day is below this. */
export const EXAM_PREP_RECALL = 0.9

export interface QueueCard {
  card: ReviewCard
  unitId: number
  unitTitle: string
  /** An answer is saved but not graded yet. */
  pendingGrade: boolean
  /** Learned or reviewed today already. */
  doneToday: boolean
}

/** The exam that is close today, with each of its units' share of it. */
export interface CloseExam {
  exam: ExamInfo & { date: string }
  inDays: number
  /** Share of the exam per unit, summing to 1. */
  share: Map<number, number>
  weightsGiven: boolean
}

/** The nearest exam dated within the window (today included); its units, or every unit when it names none. */
export function closeExam(exams: ExamInfo[], today: string, allUnitIds: number[]): CloseExam | null {
  const near = exams
    .filter((e): e is ExamInfo & { date: string } => e.date !== null)
    .map((e) => ({ exam: e, inDays: daysBetween(today, e.date) }))
    .filter((e) => e.inDays >= 0 && e.inDays <= EXAM_WINDOW_DAYS)
    .sort((a, b) => a.inDays - b.inDays || a.exam.id - b.exam.id)[0]
  if (!near) return null
  const units = near.exam.units.length > 0 ? near.exam.units : allUnitIds.map((id) => ({ id, title: '', examWeight: null }))
  const given = units.filter((u) => u.examWeight !== null && u.examWeight > 0)
  const weightsGiven = given.length > 0
  // Units without a weight get the average of the given ones (or all the same when none is given).
  const fallback = weightsGiven ? given.reduce((n, u) => n + (u.examWeight ?? 0), 0) / given.length : 1
  const raw = units.map((u) => [u.id, u.examWeight !== null && u.examWeight > 0 ? u.examWeight : fallback] as const)
  const total = raw.reduce((n, [, w]) => n + w, 0)
  return { exam: near.exam, inDays: near.inDays, share: new Map(raw.map(([id, w]) => [id, total > 0 ? w / total : 0])), weightsGiven }
}

export function examReason(close: CloseExam, unitId: number, strength: { recallOnExamDay: number | null; mastery: number | null }): Reason {
  return { code: 'exam', exam: close.exam.title, inDays: close.inDays, weightShare: close.share.get(unitId) ?? 0, weightsGiven: close.weightsGiven, ...strength }
}

export interface PlannedItem {
  conceptId: number
  unitId: number
  unitTitle: string
  reasons: Reason[]
}

export interface Plan {
  items: PlannedItem[]
  /** Due today or overdue (not counting concepts waiting for a grade or done today). */
  due: number
  held: number
  catchUpDay: string | null
}

const recallOn = (c: ReviewCard, day: string): number => recallChance({ card: storedCard(c), lastDay: c.lastDay }, day)

export function planReviews(input: { today: string; cards: QueueCard[]; close: CloseExam | null; limit: number; answeredToday: number }): Plan {
  const { today, close } = input
  const open = input.cards.filter((c) => !c.pendingGrade && !c.doneToday)
  const inExam = (c: QueueCard) => close !== null && close.share.has(c.unitId)
  const scored = open.map((c) => {
    const isDue = daysBetween(c.card.dueDay, today) >= 0
    const recallNow = recallOn(c.card, today)
    const recallExam = close ? recallOn(c.card, close.exam.date) : null
    const examPriority = close && inExam(c) ? (close.share.get(c.unitId) ?? 0) * (1 - (recallExam ?? 0)) : 0
    const tier = isDue ? (inExam(c) ? 0 : 1) : inExam(c) && recallExam !== null && recallExam < EXAM_PREP_RECALL ? 2 : 3
    const reasons: Reason[] = []
    if (isDue) reasons.push({ code: 'due', overdueDays: daysBetween(c.card.dueDay, today) })
    if (c.card.lapsed) reasons.push({ code: 'lapsed' })
    if (close && inExam(c) && tier <= 2) reasons.push(examReason(close, c.unitId, { recallOnExamDay: recallExam, mastery: null }))
    if (tier === 2) reasons.push({ code: 'exam-prep' })
    return { c, isDue, tier, sortKey: tier === 0 || tier === 2 ? -examPriority : recallNow, reasons }
  })
  const candidates = scored.filter((s) => s.tier <= 2).sort((a, b) => a.tier - b.tier || a.sortKey - b.sortKey || a.c.card.conceptId - b.c.card.conceptId)
  const room = Math.max(0, input.limit - input.answeredToday)
  const chosen = candidates.slice(0, room)
  const due = scored.filter((s) => s.isDue).length
  const held = candidates.slice(room).filter((s) => s.isDue).length
  // Held reviews go from tomorrow at the daily limit (reviews falling due meanwhile not counted).
  const catchUpDay = held > 0 && input.limit > 0 ? addDays(today, Math.ceil(held / input.limit)) : null
  const items = chosen.map((s) => ({ conceptId: s.c.card.conceptId, unitId: s.c.unitId, unitTitle: s.c.unitTitle, reasons: s.reasons }))
  return { items: interleave(items), due, held, catchUpDay }
}

/**
 * Orders items so that consecutive items come from different units whenever possible: each step
 * takes the highest-priority remaining item from a unit other than the previous item's. A unit
 * repeats only when no other unit has items left. The input order is the priority order.
 */
export function interleave<T extends { unitId: number }>(items: T[]): T[] {
  const left = [...items]
  const out: T[] = []
  while (left.length > 0) {
    const previous = out[out.length - 1]?.unitId
    const i = left.findIndex((x) => x.unitId !== previous)
    out.push(...left.splice(i < 0 ? 0 : i, 1))
  }
  return out
}
