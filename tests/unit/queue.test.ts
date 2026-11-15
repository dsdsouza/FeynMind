import { describe, expect, it } from 'vitest'
import type { ExamInfo } from '../../src/shared/knowledge'
import { reasonText } from '../../src/shared/reviews'
import { addDays, closeExam, interleave, planReviews, replayCard, type QueueCard, type ReviewCard } from '../../src/main/learner'

const TODAY = '2026-11-20'

/** A card learned `learnedAgo` days ago with Good, due `dueIn` days from today (negative: overdue). */
function card(conceptId: number, unitId: number, dueIn: number, opts: { lapsed?: boolean; learnedAgo?: number } = {}): QueueCard {
  const learnedDay = addDays(TODAY, -(opts.learnedAgo ?? 10))
  const state = replayCard([{ day: learnedDay, rating: 'good' }])
  if (!state) throw new Error('no card')
  const c: ReviewCard = {
    conceptId,
    sessionId: 1,
    dueDay: addDays(TODAY, dueIn),
    stability: state.stability,
    difficulty: state.difficulty,
    reps: 1,
    lapses: opts.lapsed ? 1 : 0,
    lastDay: learnedDay,
    learnedDay,
    learnedAt: `${learnedDay}T12:00:00.000Z`,
    lapsed: opts.lapsed ?? false
  }
  return { card: c, unitId, unitTitle: `Unit ${unitId}`, pendingGrade: false, doneToday: false }
}

describe('today\'s reviews', () => {
  it('takes due and overdue concepts, most at risk first, and leaves out waiting and done ones', () => {
    const cards = [card(1, 1, 0), card(2, 1, -5), card(3, 2, 1), { ...card(4, 2, -1), pendingGrade: true }, { ...card(5, 2, 0), doneToday: true }]
    const plan = planReviews({ today: TODAY, cards, close: null, limit: 25, answeredToday: 0 })
    expect(plan.items.map((i) => i.conceptId).sort()).toEqual([1, 2])
    expect(plan.due).toBe(2)
    expect(plan.held).toBe(0)
    expect(plan.items.find((i) => i.conceptId === 2)?.reasons.map(reasonText)).toEqual(['Overdue by 5 days'])
  })

  it('holds a backlog beyond the daily limit and says when it is cleared', () => {
    const cards = Array.from({ length: 40 }, (_, i) => card(i + 1, (i % 3) + 1, -(i % 7)))
    const plan = planReviews({ today: TODAY, cards, close: null, limit: 10, answeredToday: 4 })
    expect(plan.items).toHaveLength(6)
    expect(plan.due).toBe(40)
    expect(plan.held).toBe(34)
    expect(plan.catchUpDay).toBe(addDays(TODAY, 4))
    // Nothing left of today's limit: nothing planned.
    expect(planReviews({ today: TODAY, cards, close: null, limit: 10, answeredToday: 10 }).items).toHaveLength(0)
  })

  it('mixes units so the same unit never comes twice in a row while another has items', () => {
    expect(interleave([1, 1, 1, 2, 2, 3].map((unitId, i) => ({ unitId, i }))).map((x) => x.unitId)).toEqual([1, 2, 1, 2, 1, 3])
    expect(interleave([1, 1, 1, 2].map((unitId) => ({ unitId }))).map((x) => x.unitId)).toEqual([1, 2, 1, 1])
    const cards = [card(1, 1, 0), card(2, 1, 0), card(3, 1, 0), card(4, 2, 0), card(5, 2, 0), card(6, 3, 0)]
    const units = planReviews({ today: TODAY, cards, close: null, limit: 25, answeredToday: 0 }).items.map((i) => i.unitId)
    for (let i = 1; i < units.length - 1; i++) expect(units[i]).not.toBe(units[i - 1])
  })
})

describe('exam priorities', () => {
  const exam = (date: string | null, units: ExamInfo['units']): ExamInfo => ({ id: 7, title: 'Quiz 5', date, weight: null, units })

  it('is close within 14 days, with equal shares when the syllabus gives no weights', () => {
    const units = [{ id: 1, title: 'A', examWeight: null }, { id: 2, title: 'B', examWeight: null }]
    expect(closeExam([exam(addDays(TODAY, 15), units)], TODAY, [1, 2])).toBeNull()
    expect(closeExam([exam(addDays(TODAY, -1), units)], TODAY, [1, 2])).toBeNull()
    const close = closeExam([exam(addDays(TODAY, 6), units)], TODAY, [1, 2])
    expect(close).toMatchObject({ inDays: 6, weightsGiven: false })
    expect(close?.share.get(1)).toBe(0.5)
    // Given weights are normalised; an exam naming no units covers the whole course.
    const weighted = closeExam([exam(addDays(TODAY, 3), [{ id: 1, title: 'A', examWeight: 30 }, { id: 2, title: 'B', examWeight: 10 }])], TODAY, [1, 2])
    expect(weighted?.share.get(1)).toBe(0.75)
    expect(closeExam([exam(TODAY, [])], TODAY, [1, 2, 3])?.share.size).toBe(3)
  })

  it('puts the exam\'s units first, adds early reviews of weak concepts, and says why', () => {
    const close = closeExam([exam(addDays(TODAY, 6), [{ id: 2, title: 'B', examWeight: null }])], TODAY, [1, 2])
    // Concept 1 (unit 1, not on the exam) is more overdue; concept 2 is on the exam; concept 3 is on
    // the exam, not due, and learned long ago, so weak on the exam day.
    const cards = [card(1, 1, -4), card(2, 2, 0), card(3, 2, 5, { learnedAgo: 30 })]
    const plan = planReviews({ today: TODAY, cards, close, limit: 25, answeredToday: 0 })
    expect(plan.items.map((i) => i.conceptId)).toEqual([2, 1, 3])
    expect(plan.items[0]?.reasons.map(reasonText)).toEqual([expect.stringMatching(/^Due today$/), expect.stringMatching(/^Quiz 5 in 6 days · equal weight \(the syllabus gives none\) · predicted recall on the day \d+%$/)])
    expect(plan.items[2]?.reasons.map((r) => r.code)).toEqual(['exam', 'exam-prep'])
    expect(plan.due).toBe(2)
    // Without the exam, the overdue concept comes first and nothing is reviewed early.
    expect(planReviews({ today: TODAY, cards, close: null, limit: 25, answeredToday: 0 }).items.map((i) => i.conceptId)).toEqual([1, 2])
  })
})
