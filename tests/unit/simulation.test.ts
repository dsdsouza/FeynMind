import { describe, expect, it } from 'vitest'
import type { LessonView } from '../../src/shared/tutor'
import { daysBetween, studyDay } from '../../src/main/learner'
import { seeded, type SeededHarness } from './tutorHarness'

// A learner over 90 simulated days with the fake clock: learns three concepts in the first week,
// reviews whatever is due each day, misses relation's third review, and takes a week off. Checks
// that reviews fall due on the expected days, that the lapse brings relation back the next day,
// and that the week off leaves the overdue reviews waiting until the learner returns.

const DAYS = 90
const OFF = { from: 30, to: 36 }

async function learn(t: SeededHarness, conceptId: number, opening: string): Promise<void> {
  let view: LessonView = await t.tutor.openLesson(t.session.id, conceptId)
  const answer = async (text: string) => {
    if (view.interleave && view.interleave.attempt === null) t.tutor.answerInterleave(view.lessonId, view.interleave.itemId, 'RIGHT', false)
    else t.tutor.answer(view.lessonId, view.question?.id ?? 0, text, false)
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
  }
  await answer(opening)
  for (let guard = 0; guard < 20 && view.step !== 'done'; guard++) {
    view = t.tutor.continue(view.lessonId)
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
    if (view.step === 'done') break
    if (view.step !== 'explain' && (view.interleave?.attempt === null || view.attempt === null)) await answer('RIGHT')
  }
  expect(view.step).toBe('done')
}

describe('a learner over 90 days', () => {
  it('reviews each concept on the expected days', async () => {
    const t = seeded()
    const names = new Map(Object.entries(t.ids).map(([name, id]) => [id, name]))
    const start = studyDay(t.clock.now(), t.clock.timeZone())
    const reviewed: Record<string, number[]> = { relation: [], function: [], vector: [] }
    const missed: Record<string, number[]> = { relation: [], function: [], vector: [] }
    const lessons: Record<number, [number, string][]> = { 0: [[t.ids['relation'] as number, 'HALF']], 1: [[t.ids['vector'] as number, 'RIGHT']], 4: [[t.ids['function'] as number, 'HALF']] }

    for (let d = 0; d < DAYS; d++) {
      const today = studyDay(t.clock.now(), t.clock.timeZone())
      expect(daysBetween(start, today)).toBe(d)
      if (d < OFF.from || d > OFF.to) {
        const state = t.tutor.reviews.todayState(t.session.id)
        expect(state.planned.length).toBeLessThanOrEqual(state.limit)
        if (state.planned.length > 0) {
          const sitting = await t.tutor.reviews.start(t.session.id)
          for (const item of sitting.items) {
            const name = names.get(item.conceptId) ?? '?'
            // Relation's third review is answered wrongly; everything else is right.
            const wrong = name === 'relation' && reviewed.relation.length === 2 && missed.relation.length === 0
            t.tutor.reviews.answer(item.id, wrong ? 'wrong' : 'RIGHT', false)
            await t.tutor.idle()
            reviewed[name]?.push(d)
            if (wrong) missed[name]?.push(d)
          }
        }
        for (const [conceptId, opening] of lessons[d] ?? []) await learn(t, conceptId, opening)
      }
      // The next day, at a different hour, to show the time of day does not matter.
      t.clock.advanceDays(1)
      t.clock.time += (d % 3) * 3_600_000 - 3_600_000
    }

    // Every review, including the questions from earlier concepts mixed into lessons, from the log.
    const all: Record<string, number[]> = { relation: [], function: [], vector: [] }
    for (const e of t.db.prepare<[], { conceptId: number; day: string }>("SELECT concept_id AS conceptId, day FROM review_events WHERE kind = 'review' ORDER BY id").all()) {
      all[names.get(e.conceptId) ?? '?']?.push(daysBetween(start, e.day))
    }
    console.log(JSON.stringify({ reviewed, missed, all }))
    // Relation (learned day 0, rated Good): day 3, day 7 (brought forward for recall at 7 days),
    // missed on its third review, back the next day, then spaced out again.
    expect(missed.relation).toHaveLength(1)
    const lapse = missed.relation[0] as number
    expect(reviewed.relation[reviewed.relation.indexOf(lapse) + 1]).toBe(lapse + 1)
    expect(reviewed).toEqual(GOLDEN)
    expect(all).toEqual(GOLDEN)
    // Nothing is reviewed during the week off; whatever fell due then waits for day 37.
    for (const days of Object.values(reviewed)) expect(days.filter((d) => d >= OFF.from && d <= OFF.to)).toEqual([])
    // Delayed recall is measured for every concept learned more than two weeks before the end.
    const recall = t.tutor.reviews.progress(t.session.id).recall
    expect(recall.find((r) => r.name === '7 days')?.measured).toBe(3)
  })
})

/**
 * Days (from day 0) each concept was reviewed. Checked by hand against the rules:
 * - relation, learned day 0 (Good): day 3; day 7 (FSRS said 17, past the 4-13 window); day 37
 *   (FSRS's 37 is inside the 21-45 window, and the week off ends on 36): its third review, missed;
 *   day 38, the next day; then 43, 55, 82, spacing out again.
 * - vector, learned day 1 (Easy: right before teaching): day 9 (8 days); due day 31 (brought
 *   forward to 30 days after learning for the 21-45 window), which falls in the week off, so day 37.
 * - function, learned day 4 (Good): day 7; day 11 (7 days after learning); day 41.
 */
const GOLDEN: Record<string, number[]> = { relation: [3, 7, 37, 38, 43, 55, 82], function: [7, 11, 41], vector: [9, 37] }
