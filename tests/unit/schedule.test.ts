import { describe, expect, it } from 'vitest'
import { MASTERY, masteryStatus, replay, type Evidence } from '../../src/main/learner/mastery'
import { addDays } from '../../src/main/learner/days'
import { learnedRating, recallChance, replayCard, reviewRating, type ReviewRating, type ScheduleEvent } from '../../src/main/learner/schedule'

describe('review rating', () => {
  it('follows the approved table', () => {
    const cases: [Parameters<typeof reviewRating>[0], ReviewRating][] = [
      [{ verdict: 'incorrect', reasoning: null, hintUsed: false, skipped: false }, 'again'],
      [{ verdict: 'incorrect', reasoning: null, hintUsed: false, skipped: true }, 'again'],
      [{ verdict: 'incorrect', reasoning: 'sound', hintUsed: true, skipped: false }, 'again'],
      // Flawed reasoning is Again whatever the verdict (the grader already caps it at partly correct).
      [{ verdict: 'partial', reasoning: 'flawed', hintUsed: false, skipped: false }, 'again'],
      [{ verdict: 'correct', reasoning: 'flawed', hintUsed: false, skipped: false }, 'again'],
      [{ verdict: 'partial', reasoning: null, hintUsed: true, skipped: false }, 'again'],
      [{ verdict: 'partial', reasoning: 'sound', hintUsed: true, skipped: false }, 'again'],
      [{ verdict: 'partial', reasoning: null, hintUsed: false, skipped: false }, 'hard'],
      [{ verdict: 'partial', reasoning: 'none', hintUsed: false, skipped: false }, 'hard'],
      [{ verdict: 'correct', reasoning: null, hintUsed: true, skipped: false }, 'hard'],
      [{ verdict: 'correct', reasoning: 'sound', hintUsed: true, skipped: false }, 'hard'],
      [{ verdict: 'correct', reasoning: null, hintUsed: false, skipped: false }, 'good'],
      [{ verdict: 'correct', reasoning: 'sound', hintUsed: false, skipped: false }, 'good'],
      [{ verdict: 'correct', reasoning: 'none', hintUsed: false, skipped: false }, 'good']
    ]
    for (const [outcome, rating] of cases) expect([outcome, reviewRating(outcome)]).toEqual([outcome, rating])
  })

  it('rates first learning from the lesson: easy when known before teaching, hard after struggling', () => {
    expect(learnedRating([{ kind: 'opening', verdict: 'correct' }, { kind: 'unaided', verdict: 'correct' }])).toBe('easy')
    expect(learnedRating([{ kind: 'opening', verdict: 'incorrect' }, { kind: 'guided', verdict: 'correct' }, { kind: 'partial', verdict: 'correct' }, { kind: 'unaided', verdict: 'correct' }])).toBe('good')
    expect(learnedRating([{ kind: 'opening', verdict: 'correct' }, { kind: 'guided', verdict: 'partial' }, { kind: 'unaided', verdict: 'correct' }])).toBe('good')
    expect(learnedRating([{ kind: 'opening', verdict: 'correct' }, { kind: 'unaided', verdict: 'partial' }, { kind: 'unaided', verdict: 'correct' }])).toBe('hard')
    expect(learnedRating([{ kind: 'guided', verdict: 'incorrect' }, { kind: 'partial', verdict: 'partial' }, { kind: 'unaided', verdict: 'correct' }])).toBe('hard')
  })
})

const DAY0 = '2026-11-14'
const ev = (n: number, rating: ReviewRating): ScheduleEvent => ({ day: addDays(DAY0, n), rating })

/** Reviews a card on each due day with the given ratings; returns the days reviewed. */
function walk(first: ReviewRating, ratings: ReviewRating[]): number[] {
  const events = [ev(0, first)]
  const days = [0]
  for (const r of ratings) {
    const card = replayCard(events)
    const due = Math.round((Date.parse(`${card?.dueDay}T12:00:00Z`) - Date.parse(`${DAY0}T12:00:00Z`)) / 86_400_000)
    days.push(due)
    events.push(ev(due, r))
  }
  return days
}

describe('card replay', () => {
  it('reviews an always-right concept on day 3, on day 7 (brought forward for recall at 7 days), then spaced out', () => {
    // FSRS alone would go 3, 17, 74: day 17 jumps past the 4-13 window, so it is brought forward to day 7.
    // From day 7 the next review (37) already falls in the 21-45 window.
    expect(walk('good', ['good', 'good', 'good', 'good'])).toEqual([0, 3, 7, 37, 148])
  })

  it('starts sooner after a struggle and later when known before teaching', () => {
    expect(replayCard([ev(0, 'hard')])?.dueDay).toBe(addDays(DAY0, 2))
    expect(replayCard([ev(0, 'easy')])?.dueDay).toBe(addDays(DAY0, 8))
  })

  it('brings a lapsed concept back the next day with lower stability', () => {
    const before = replayCard([ev(0, 'good'), ev(3, 'good')])
    const after = replayCard([ev(0, 'good'), ev(3, 'good'), ev(7, 'again')])
    expect(after?.dueDay).toBe(addDays(DAY0, 8))
    expect(after?.lapsed).toBe(true)
    expect(after?.lapses).toBe(1)
    expect(after?.stability ?? 99).toBeLessThan(before?.stability ?? 0)
  })

  it('treats a day that goes backwards as the previous day', () => {
    const forward = replayCard([ev(0, 'good'), ev(3, 'good')])
    const backwards = replayCard([ev(0, 'good'), ev(3, 'good'), ev(1, 'good')])
    expect(backwards?.lastDay).toBe(forward?.lastDay)
  })

  it('gives the chance of recall falling over time, 90% at the stability', () => {
    const card = replayCard([ev(0, 'good')])
    if (!card) throw new Error('no card')
    expect(recallChance(card, DAY0)).toBe(1)
    expect(recallChance(card, addDays(DAY0, 1))).toBeGreaterThan(recallChance(card, addDays(DAY0, 10)))
    expect(recallChance(card, addDays(DAY0, Math.round(card.stability)))).toBeCloseTo(0.9, 1)
  })
})

describe('lapse rule', () => {
  const lesson: Evidence[] = [
    { kind: 'answer', question: 'opening', score: 1 },
    { kind: 'answer', question: 'guided', score: 1 },
    { kind: 'answer', question: 'partial', score: 1 },
    { kind: 'answer', question: 'unaided', score: 1 }
  ]
  const record = { unaidedCorrect: true, lastVerdict: 'correct' as const }

  it('leaves the estimate of existing lesson histories unchanged', () => {
    expect(masteryStatus(lesson, record, false)).toEqual({ p: replay(lesson), mastered: true, gap: null, lapsed: false })
    expect(replay(lesson)).toBeCloseTo(0.996, 3)
  })

  it('caps the estimate at 0.75 after a failed review and clears mastery; a correct re-teach check restores it', () => {
    const lapse: Evidence = { kind: 'answer', question: 'review', score: 0, lapse: true }
    const lapsed = masteryStatus([...lesson, lapse], record, true)
    expect(lapsed.p).toBe(MASTERY.lapseCap)
    expect(lapsed).toMatchObject({ mastered: false, lapsed: true, gap: null })
    const fixed = masteryStatus([...lesson, lapse, { kind: 'answer', question: 'unaided', score: 1 }], record, true)
    expect(fixed.p).toBeCloseTo(0.955, 3)
    expect(fixed).toMatchObject({ mastered: true, lapsed: false })
    const missed = masteryStatus([...lesson, lapse, { kind: 'answer', question: 'unaided', score: 0 }], record, true)
    expect(missed.p).toBeCloseTo(0.37, 2)
    expect(missed.mastered).toBe(false)
  })

  it('keeps a learned concept mastered through a partly right review (Hard is a pass)', () => {
    const s = masteryStatus([...lesson, { kind: 'answer', question: 'review', score: 0.5 }, { kind: 'answer', question: 'review', score: 0.5 }], record, true)
    expect(s.mastered).toBe(true)
    expect(s.p).toBeLessThan(MASTERY.mastered)
  })

  it('does not count a right answer after a hint toward mastery again', () => {
    const lapse: Evidence = { kind: 'answer', question: 'review', score: 0, lapse: true }
    const s = masteryStatus([...lesson, lapse, { kind: 'answer', question: 'review', score: 1, hint: true }, { kind: 'answer', question: 'review', score: 1, hint: true }], record, true)
    expect(s.mastered).toBe(false)
  })
})
