import { describe, expect, it } from 'vitest'
import type { ExamInfo } from '../../src/shared/knowledge'
import { reasonText } from '../../src/shared/reviews'
import type { LessonView } from '../../src/shared/tutor'
import { addDays, studyDay } from '../../src/main/learner'
import { ProviderError } from '../../src/main/providers'
import { FakeAppClock } from './fakes/fakeClock'
import { calls, seeded, type SeededHarness } from './tutorHarness'

/** Works through a concept's lesson to mastery: the opening answer given, every later answer RIGHT. */
async function learn(t: SeededHarness, conceptId: number, opening = 'HALF'): Promise<LessonView> {
  let view = await t.tutor.openLesson(t.session.id, conceptId)
  const answerCurrent = async (text: string) => {
    if (view.interleave && view.interleave.attempt === null) t.tutor.answerInterleave(view.lessonId, view.interleave.itemId, 'RIGHT', false)
    else t.tutor.answer(view.lessonId, view.question?.id ?? 0, text, false)
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
  }
  await answerCurrent(opening)
  for (let guard = 0; guard < 20 && view.step !== 'done'; guard++) {
    view = t.tutor.continue(view.lessonId)
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
    if (view.step === 'done') break
    if (view.step !== 'explain' && (view.interleave?.attempt === null || view.attempt === null)) await answerCurrent('RIGHT')
  }
  expect(view.step).toBe('done')
  return view
}

const day = (t: SeededHarness) => studyDay(t.clock.now(), t.clock.timeZone())

describe('review scheduling', () => {
  it('gives a learned concept a due date, and its review appears on that day and not before', async () => {
    const t = seeded()
    const relation = t.ids['relation'] as number
    await learn(t, relation)
    const card = t.tutor.learner.card(relation)
    // Missed the opening question, then right throughout: Good, so the first review is in 3 days.
    expect(card).toMatchObject({ learnedDay: '2026-11-14', dueDay: '2026-11-17', reps: 1 })
    expect(t.tutor.path(t.session.id).units[0]?.concepts.find((c) => c.id === relation)?.review).toMatchObject({ dueDay: '2026-11-17', lapsed: false })
    expect(t.tutor.reviews.todayState(t.session.id)).toMatchObject({ due: 0, planned: [], lessonsWait: false })
    t.clock.advanceDays(2)
    expect(t.tutor.reviews.todayState(t.session.id).due).toBe(0)
    t.clock.advanceDays(1)
    const today = t.tutor.reviews.todayState(t.session.id)
    expect(today).toMatchObject({ day: '2026-11-17', due: 1, lessonsWait: true })
    expect(today.planned.map((p) => [p.name, p.reasons.map(reasonText)])).toEqual([['relation', ['Due today']]])
    expect(today.estimate).toMatchObject({ calls: 1, grades: 1, newQuestionSets: 0 })
  })

  it('opens a sitting with recall only: an unanswered stored question, no explanation, the concept named after answering', async () => {
    const t = seeded()
    const relation = t.ids['relation'] as number
    await learn(t, relation)
    const answered = new Set(t.db.prepare<[number], number>('SELECT question_id FROM attempts WHERE concept_id = ?').pluck().all(relation))
    t.clock.advanceDays(3)
    const before = calls(t.provider)
    let sitting = await t.tutor.reviews.start(t.session.id)
    expect(calls(t.provider)).toBe(before)
    const item = sitting.items[0]
    expect(item?.question?.stem).toMatch(/^unaided question \d about the concept$/)
    expect(answered.has(item?.question?.id ?? 0)).toBe(false)
    expect(item?.conceptName).toBe('')
    t.tutor.reviews.answer(item?.id ?? 0, 'RIGHT', false)
    await t.tutor.idle()
    sitting = t.tutor.reviews.current(t.session.id) ?? sitting
    expect(sitting.status).toBe('done')
    expect(sitting.items[0]).toMatchObject({ conceptName: 'relation', status: 'answered', lapsed: false })
    expect(sitting.items[0]?.attempt?.grades[0]?.verdict).toBe('correct')
    // Good again: the next review jumps past the 4-13 day window, so it is brought to day 7.
    expect(sitting.items[0]?.nextDue).toBe('2026-11-21')
    expect(t.tutor.reviews.todayState(t.session.id)).toMatchObject({ due: 0, answeredToday: 1, lessonsWait: false })
  })

  it('brings a missed review back the next day, unmasters the concept, locks new lessons that need it, and re-teaches', async () => {
    const t = seeded()
    const relation = t.ids['relation'] as number
    const fn = t.ids['function'] as number
    await learn(t, relation)
    t.clock.advanceDays(3)
    const sitting = await t.tutor.reviews.start(t.session.id)
    const item = sitting.items[0]
    t.tutor.reviews.answer(item?.id ?? 0, 'wrong', false)
    await t.tutor.idle()
    let view = t.tutor.reviews.current(t.session.id)?.items[0]
    expect(view).toMatchObject({ lapsed: true, nextDue: '2026-11-18' })
    expect(t.tutor.learner.get(relation)).toMatchObject({ mastered: false, lapsed: true, p: 0.75 })
    const path = t.tutor.path(t.session.id)
    expect(path.units[0]?.concepts.find((c) => c.id === fn)).toMatchObject({ locked: true, waitingFor: ['relation'] })
    // The lapsed concept is not offered as a new lesson: it gets the short re-teach instead.
    expect(path.next?.conceptId).not.toBe(relation)
    expect(path.next?.name).toBe('vector')

    const before = calls(t.provider)
    await t.tutor.reviews.reteach(item?.id ?? 0)
    await t.tutor.idle()
    view = t.tutor.reviews.current(t.session.id)?.items[0]
    expect(calls(t.provider)).toBe(before + 1)
    expect(view?.reteach?.markdown).toContain('[S1 p. 11]')
    expect(t.reviewStream.some((e) => e.kind === 'text')).toBe(true)
    expect(view?.reteachQuestion?.id).not.toBe(view?.question?.id)
    t.tutor.reviews.answerReteach(item?.id ?? 0, 'RIGHT', false)
    await t.tutor.idle()
    expect(t.tutor.learner.get(relation)).toMatchObject({ mastered: true, lapsed: false })
    expect(t.tutor.path(t.session.id).units[0]?.concepts.find((c) => c.id === fn)?.locked).toBe(false)
    // The re-teach check counts toward mastery, not the schedule: the review is still due tomorrow.
    expect(t.tutor.learner.card(relation)?.dueDay).toBe('2026-11-18')
  })

  it('after a missed re-teach check, shows the stored lesson explanation without a call', async () => {
    const t = seeded()
    const relation = t.ids['relation'] as number
    await learn(t, relation)
    t.clock.advanceDays(3)
    const item = (await t.tutor.reviews.start(t.session.id)).items[0]
    t.tutor.reviews.answer(item?.id ?? 0, '', true)
    await t.tutor.reviews.reteach(item?.id ?? 0)
    await t.tutor.idle()
    const before = calls(t.provider)
    t.tutor.reviews.answerReteach(item?.id ?? 0, '', true)
    const view = t.tutor.reviews.current(t.session.id)?.items[0]
    expect(calls(t.provider)).toBe(before)
    expect(view?.lessonExplanation).toContain('## Explanation')
    expect(t.tutor.learner.get(relation).mastered).toBe(false)
  })

  it('writes new review questions only when every stored one was seen recently, from the same passages, once', async () => {
    const t = seeded()
    const relation = t.ids['relation'] as number
    await learn(t, relation)
    // Answer every reviewable question of the concept today, as if all were seen this week.
    const lesson = t.tutor.repo.lessonOfConcept(relation)
    for (const q of t.tutor.repo.reviewableQuestions(relation)) {
      t.db
        .prepare("INSERT INTO attempts (session_id, concept_id, question_id, lesson_id, answer_text, shown_at, submitted_at, status, purpose) VALUES (?, ?, ?, ?, 'x', ?, ?, 'graded', 'reteach')")
        .run(t.session.id, relation, q.id, lesson?.id, new Date(t.clock.now()).toISOString(), new Date(t.clock.now()).toISOString())
    }
    t.clock.advanceDays(3)
    expect(t.tutor.reviews.todayState(t.session.id).estimate).toMatchObject({ grades: 1, newQuestionSets: 1, calls: 2 })
    const before = calls(t.provider)
    const sitting = await t.tutor.reviews.start(t.session.id)
    const generated = t.provider.generateCalls.slice(before).filter((r) => r.system?.includes('You write review questions'))
    expect(generated).toHaveLength(1)
    // Grounded in the lesson's passages, and told what was already asked.
    expect(generated[0]?.prompt).toContain(lesson?.passages[0]?.text ?? '?')
    expect(generated[0]?.prompt).toContain('- opening question 0 about the concept')
    expect(sitting.items[0]?.question?.stem).toMatch(/^review variant \d+ about relation$/)
    expect(t.tutor.repo.questionsOf(relation, 'unaided').some((q) => q.stem.startsWith('review variant'))).toBe(false)
    expect(t.tutor.repo.reviewableQuestions(relation).filter((q) => q.purpose === 'review')).toHaveLength(3)
  })

  it('saves a review answered offline, grades it when the connection returns, and schedules from the day it was given', async () => {
    const t = seeded()
    const relation = t.ids['relation'] as number
    await learn(t, relation)
    t.clock.advanceDays(3)
    const item = (await t.tutor.reviews.start(t.session.id)).items[0]
    t.online.value = false
    const before = calls(t.provider)
    t.tutor.reviews.answer(item?.id ?? 0, 'RIGHT', false)
    await t.tutor.idle()
    expect(calls(t.provider)).toBe(before)
    let view = t.tutor.reviews.current(t.session.id)?.items[0]
    expect(view).toMatchObject({ status: 'answered', error: 'Saved. It will be graded when you are back online.' })
    expect(view?.attempt?.status).toBe('saved')
    // Viewing what is due and progress works offline, without calls.
    expect(t.tutor.reviews.todayState(t.session.id)).toMatchObject({ waitingGrades: 1, due: 0 })
    expect(t.tutor.reviews.progress(t.session.id).concepts.find((c) => c.conceptId === relation)?.state).toBe('scheduled')
    expect(calls(t.provider)).toBe(before)

    // A day later the connection is back.
    t.clock.advanceDays(1)
    t.online.value = true
    expect(t.tutor.reviews.resumePending()).toBe(1)
    await t.tutor.idle()
    const sittingId = t.db.prepare<[number], number>('SELECT sitting_id FROM review_items WHERE id = ?').pluck().get(item?.id ?? 0) as number
    view = t.tutor.reviews.sittingView(sittingId).items[0]
    expect(t.sittings.at(-1)?.items[0]?.attempt?.status).toBe('graded')
    expect(view?.attempt?.grades[0]?.verdict).toBe('correct')
    expect(t.tutor.learner.card(relation)).toMatchObject({ lastDay: '2026-11-17', dueDay: '2026-11-21' })
  })

  it('treats a network failure like being offline', async () => {
    const t = seeded()
    await learn(t, t.ids['relation'] as number)
    t.clock.advanceDays(3)
    const item = (await t.tutor.reviews.start(t.session.id)).items[0]
    t.provider.failWith = new ProviderError('Could not reach the provider. Check the connection.', 'network')
    t.provider.respond = null
    t.tutor.reviews.answer(item?.id ?? 0, 'RIGHT', false)
    await t.tutor.idle()
    expect(t.tutor.reviews.current(t.session.id)?.items[0]?.error).toBe('Saved. It will be graded when you are back online.')
    t.tutor.reviews.stop()
  })
})

describe('sittings and lessons', () => {
  it('makes new lessons wait for due reviews unless skipped today, and honours a changed daily limit', async () => {
    const t = seeded()
    await learn(t, t.ids['relation'] as number)
    await learn(t, t.ids['vector'] as number)
    t.clock.advanceDays(3)
    expect(t.tutor.path(t.session.id).reviewsFirst).toBe(true)
    await expect(t.tutor.openLesson(t.session.id, t.ids['function'] as number)).rejects.toThrow("Do today's reviews first")
    expect(t.tutor.reviews.setDailyLimit(t.session.id, 1)).toMatchObject({ due: 2, held: 1, limit: 1, catchUpDay: '2026-11-18' })
    expect(() => t.tutor.reviews.setDailyLimit(t.session.id, 0)).toThrow(/1 to 200/)
    const skipped = t.tutor.reviews.skipToday(t.session.id)
    expect(skipped).toMatchObject({ skippedToday: true, lessonsWait: false })
    await t.tutor.openLesson(t.session.id, t.ids['function'] as number)
    // Tomorrow they wait again.
    t.clock.advanceDays(1)
    expect(t.tutor.reviews.todayState(t.session.id)).toMatchObject({ skippedToday: false, lessonsWait: true })
  })

  it('mixes reviews across units in a sitting', async () => {
    const t = seeded()
    // Put vector in its own unit so the course has two topics.
    t.db.prepare('UPDATE concept_units SET unit_id = ? WHERE concept_id = ?').run(t.unit2, t.ids['vector'])
    await learn(t, t.ids['relation'] as number)
    await learn(t, t.ids['vector'] as number)
    t.clock.advanceDays(3)
    const units = (await t.tutor.reviews.start(t.session.id)).items.map((i) => i.conceptId)
    expect(units).toHaveLength(2)
    expect(new Set(units).size).toBe(2)
  })

  it('mixes one question from an earlier concept into a lesson, before the first unaided question', async () => {
    const t = seeded()
    await learn(t, t.ids['relation'] as number)
    // Two days later relation is not due (day 3) but its recall has dropped below 97%.
    t.clock.advanceDays(2)
    let view = await t.tutor.openLesson(t.session.id, t.ids['vector'] as number)
    t.tutor.answer(view.lessonId, view.question?.id ?? 0, 'HALF', false)
    await t.tutor.idle()
    view = t.tutor.continue(view.lessonId)
    await t.tutor.idle()
    view = t.tutor.continue(view.lessonId)
    for (const step of ['guided', 'partial']) {
      expect(view.question?.kind).toBe(step)
      t.tutor.answer(view.lessonId, view.question?.id ?? 0, 'RIGHT', false)
      await t.tutor.idle()
      view = t.tutor.continue(view.lessonId)
    }
    expect(view.step).toBe('partial')
    expect(view.interleave).toMatchObject({ conceptName: null, attempt: null })
    expect(view.interleave?.reasons.map(reasonText)).toEqual(['Mixed in from an earlier topic (Functions)'])
    expect(() => t.tutor.continue(view.lessonId)).toThrow('Answer the question from earlier first')
    view = t.tutor.answerInterleave(view.lessonId, view.interleave?.itemId ?? 0, 'RIGHT', false)
    await t.tutor.idle()
    view = t.tutor.view(view.lessonId)
    expect(view.interleave).toMatchObject({ conceptName: 'relation' })
    expect(view.interleave?.attempt?.grades[0]?.verdict).toBe('correct')
    view = t.tutor.continue(view.lessonId)
    expect(view.question?.kind).toBe('unaided')
    expect(view.interleave).toBeNull()
    // It was a real (early) review of relation.
    expect(t.tutor.learner.card(relation(t))?.reps).toBe(2)
  })
})

const relation = (t: SeededHarness) => t.ids['relation'] as number

describe('exam priorities', () => {
  const quiz = (t: SeededHarness, date: string, units: number[]): ExamInfo[] => [
    { id: 1, title: 'Quiz 5', date, weight: null, units: units.map((id) => ({ id, title: id === t.unit1 ? 'Functions' : 'Matrices', examWeight: null })) }
  ]

  it('recommends the exam\'s weakest heaviest concept first when the exam is close, and says why', async () => {
    let exams: ExamInfo[] = []
    const t = seeded({ exams: () => exams })
    // vector moves to unit 2; with no exam, the syllabus order starts with relation.
    t.db.prepare('UPDATE concept_units SET unit_id = ? WHERE concept_id = ?').run(t.unit2, t.ids['vector'])
    let path = t.tutor.path(t.session.id)
    expect(path.next?.name).toBe('relation')
    expect(path.next?.reasons.map(reasonText)).toEqual(['Next in the syllabus'])
    // An exam on unit 2 three weeks away changes nothing.
    exams = quiz(t, addDays(day(t), 21), [t.unit2])
    expect(t.tutor.path(t.session.id).next?.name).toBe('relation')
    expect(t.tutor.reviews.todayState(t.session.id).examFocus).toBeNull()
    // Five days away: vector, in the exam's unit, comes first, with the reason shown.
    exams = quiz(t, addDays(day(t), 5), [t.unit2])
    path = t.tutor.path(t.session.id)
    expect(path.next?.name).toBe('vector')
    expect(path.next?.reasons.map(reasonText)).toEqual(['Quiz 5 in 5 days · equal weight (the syllabus gives none) · mastery 20%'])
    expect(t.tutor.reviews.todayState(t.session.id).examFocus).toMatchObject({ title: 'Quiz 5', inDays: 5, unitTitles: ['Matrices'] })
  })
})

describe('review attempts attached to a lesson', () => {
  /** A lesson part way: the opening question answered, the explanation read, at the guided question. */
  async function midLesson(t: SeededHarness): Promise<LessonView> {
    let view = await t.tutor.openLesson(t.session.id, relation(t))
    t.tutor.answer(view.lessonId, view.question?.id ?? 0, 'HALF', false)
    await t.tutor.idle()
    view = t.tutor.continue(view.lessonId)
    await t.tutor.idle()
    return t.tutor.continue(view.lessonId)
  }

  /** Attaches a wrong review answer and a right re-teach answer to the lesson, graded, as the review service stores them. */
  function attach(t: SeededHarness, lessonId: number): void {
    const questions = t.tutor.repo.questionsOf(relation(t), 'unaided')
    for (const [purpose, verdict, q] of [['review', 'incorrect', questions[0]], ['reteach', 'correct', questions[1]]] as const) {
      const id = t.tutor.repo.addAttempt({
        sessionId: t.session.id,
        conceptId: relation(t),
        questionId: q?.id ?? 0,
        lessonId,
        diagnosticId: null,
        answer: 'attached',
        choiceIndex: null,
        skipped: false,
        shownAt: '2026-11-14T15:00:00.000Z',
        purpose
      })
      t.tutor.repo.addGrade(id, { pass: 1, verdict, score: verdict === 'correct' ? 1 : 0, criteria: [], reason: 'r', feedback: '', pages: [], outsideSources: false, gradedBy: 'local' })
    }
  }

  const strip = (v: LessonView) => ({ ...v, estimate: { ...v.estimate } })

  it('leaves lesson progress, resume and the mastery replay unchanged', async () => {
    const t = seeded()
    const view = await midLesson(t)
    t.tutor.saveDraft(view.lessonId, 'answer', 'half typed')
    const before = { view: strip(t.tutor.view(view.lessonId)), path: t.tutor.path(t.session.id), mastery: t.tutor.learner.get(relation(t)) }
    attach(t, view.lessonId)

    expect(strip(t.tutor.view(view.lessonId))).toEqual(before.view)
    expect(t.tutor.path(t.session.id)).toEqual(before.path)
    // Resume after a restart: a new service reopens the same step, question and draft.
    const resumed = await t.make().currentLesson(t.session.id)
    expect(resumed && strip(resumed)).toEqual(before.view)
    // Replaying the evidence (as a contest does) gives the same estimate and gap.
    const attemptId = t.tutor.repo.attemptsOfLesson(view.lessonId)[0]?.id ?? 0
    const replayed = t.tutor.learner.regrade(t.session.id, relation(t), attemptId)
    expect({ p: replayed.p, gap: replayed.gap, mastered: replayed.mastered }).toEqual({ p: before.mastery.p, gap: before.mastery.gap, mastered: before.mastery.mastered })
  })

  it('finishes the lesson exactly as a twin lesson without attached answers does', async () => {
    const plain = seeded()
    const withReviews = seeded()
    const finish = async (t: SeededHarness, extra: boolean) => {
      let view = await midLesson(t)
      if (extra) attach(t, view.lessonId)
      const trail: unknown[] = []
      for (let i = 0; i < 6 && view.step !== 'done'; i++) {
        t.tutor.answer(view.lessonId, view.question?.id ?? 0, 'RIGHT', false)
        await t.tutor.idle()
        view = t.tutor.view(view.lessonId)
        trail.push([view.step, view.question?.kind, view.question?.number, view.steps, view.mastery, view.canMoreQuestions])
        view = t.tutor.continue(view.lessonId)
      }
      trail.push([view.step, view.mastery])
      return trail
    }
    expect(await finish(withReviews, true)).toEqual(await finish(plain, false))
  })
})

describe('time', () => {
  it('keeps due days in study days across a time zone change and a clock that moves backwards', async () => {
    const clock = new FakeAppClock(Date.UTC(2026, 10, 15, 3, 30), 'America/New_York')
    const t = seeded({ clock })
    // 22:30 in New York on 14 November.
    await learn(t, relation(t))
    expect(t.tutor.learner.card(relation(t))).toMatchObject({ learnedDay: '2026-11-14', dueDay: '2026-11-17' })
    // Fly to Tokyo: it is already 15 November there, and the due day does not move.
    clock.zone = 'Asia/Tokyo'
    expect(t.tutor.learner.card(relation(t))?.dueDay).toBe('2026-11-17')
    expect(t.tutor.reviews.todayState(t.session.id).day).toBe('2026-11-15')
    // The system clock jumps back two days: scheduling keeps using the latest stored moment.
    clock.advanceDays(-2)
    expect(t.tutor.reviews.todayState(t.session.id)).toMatchObject({ day: '2026-11-15', clockBehind: true })
  })
})
