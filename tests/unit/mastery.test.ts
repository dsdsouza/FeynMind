import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { bandOf, LearnerRepo, MASTERY, replay, unitStanding, update, type Evidence } from '../../src/main/learner'
import { openDatabase, SessionStore } from '../../src/main/storage'

const right = (question: 'diagnostic' | 'opening' | 'guided' | 'partial' | 'unaided'): Evidence => ({ kind: 'answer', question, score: 1 })
const wrong = (question: 'diagnostic' | 'opening' | 'guided' | 'partial' | 'unaided'): Evidence => ({ kind: 'answer', question, score: 0 })
const round = (p: number): number => Math.round(p * 1000) / 1000

describe('mastery model', () => {
  it('moves as documented in docs/tech-plan.md (Tutor)', () => {
    // These figures are quoted in the tech plan; change both together.
    expect(round(replay([right('diagnostic')]))).toBe(0.474)
    expect(round(replay([wrong('diagnostic')]))).toBe(0.032)
    // A correct answer on a concept that depends on this one corroborates it.
    expect(round(replay([right('diagnostic'), { kind: 'inferred-known' }]))).toBe(0.764)
    // Known from the diagnostic and corroborated: a correct opening answer reaches the fast track.
    expect(round(replay([right('diagnostic'), { kind: 'inferred-known' }, right('opening')]))).toBeGreaterThanOrEqual(MASTERY.fastTrack)
    // One correct diagnostic answer alone does not.
    expect(replay([right('diagnostic'), right('opening')])).toBeLessThan(MASTERY.fastTrack)
    // Brand new learner who gets everything right: opening, guided, partial, unaided.
    const fresh = [right('opening'), right('guided'), right('partial'), right('unaided')]
    expect(fresh.map((_, i) => round(replay(fresh.slice(0, i + 1))))).toEqual([0.66, 0.875, 0.974, 0.996])
    // Wrong on the opening question, then right on all practice.
    const learned = [wrong('opening'), right('guided'), right('partial'), right('unaided')]
    expect(learned.map((_, i) => round(replay(learned.slice(0, i + 1))))).toEqual([0.174, 0.48, 0.835, 0.973])
  })

  it('counts a partly correct answer as half of each outcome', () => {
    const p = 0.5
    const half = update(p, { kind: 'answer', question: 'unaided', score: 0.5 })
    const r = update(p, right('unaided'))
    const w = update(p, wrong('unaided'))
    expect(half).toBeCloseTo((r + w) / 2, 10)
  })

  it('applies overrides as a floor or a ceiling', () => {
    expect(update(0.3, { kind: 'override', direction: 'known', value: 0.9 })).toBe(0.9)
    expect(update(0.95, { kind: 'override', direction: 'known', value: 0.9 })).toBe(0.95)
    expect(update(0.7, { kind: 'override', direction: 'new', value: 0.2 })).toBe(0.2)
  })

  it('gives bands and unit standings', () => {
    expect(bandOf(0.99, false)).toBe('known')
    expect(bandOf(0.99, true)).toBe('mastered')
    expect(bandOf(0.47, false)).toBe('shaky')
    expect(bandOf(0.2, false)).toBe('new')
    expect(unitStanding([])).toBe('not-assessed')
    expect(unitStanding([null, null])).toBe('not-assessed')
    expect(unitStanding(['known', 'known', 'known', 'known', 'shaky'])).toBe('known')
    expect(unitStanding(['new', 'new', 'shaky', null])).toBe('new')
    expect(unitStanding(['known', 'new', 'shaky'])).toBe('shaky')
  })
})

function seed(db: Database.Database): { sessionId: number; conceptId: number; question: (kind: string) => number; answer: (questionId: number, verdict: string, lesson: boolean) => number } {
  const sessionId = new SessionStore(db).current().id
  const conceptId = Number(db.prepare("INSERT INTO concepts (session_id, name, definition, first_material_id, first_page) VALUES (?, 'dot product', 'd', 1, 1)").run(sessionId).lastInsertRowid)
  const lessonId = Number(db.prepare("INSERT INTO lessons (session_id, concept_id, step) VALUES (?, ?, 'opening')").run(sessionId, conceptId).lastInsertRowid)
  const diagnosticId = Number(db.prepare("INSERT INTO diagnostics (session_id, kind, status) VALUES (?, 'diagnostic', 'in-progress')").run(sessionId).lastInsertRowid)
  let ordinal = 0
  return {
    sessionId,
    conceptId,
    question: (kind) =>
      Number(db.prepare("INSERT INTO questions (session_id, concept_id, kind, ordinal, stem, prompt, prompt_version, cache_key) VALUES (?, ?, ?, ?, 'Q', 'p', 1, 'k')").run(sessionId, conceptId, kind, ordinal++).lastInsertRowid),
    answer: (questionId, verdict, lesson) => {
      const attemptId = Number(
        db
          .prepare("INSERT INTO attempts (session_id, concept_id, question_id, lesson_id, diagnostic_id, shown_at, status) VALUES (?, ?, ?, ?, ?, 'now', 'graded')")
          .run(sessionId, conceptId, questionId, lesson ? lessonId : null, lesson ? null : diagnosticId).lastInsertRowid
      )
      db.prepare("INSERT INTO grades (attempt_id, pass, verdict, score, reason, graded_by) VALUES (?, 1, ?, 1, 'r', 'local')").run(attemptId, verdict)
      return attemptId
    }
  }
}

describe('learner repository', () => {
  it('needs a correct unaided answer in the lesson before a concept is mastered', () => {
    const db = openDatabase(':memory:')
    const s = seed(db)
    const learner = new LearnerRepo(db)
    learner.addEvidence(s.sessionId, s.conceptId, 'override-known', { value: 0.99 })
    let state = learner.addEvidence(s.sessionId, s.conceptId, 'answer', { attemptId: s.answer(s.question('opening'), 'correct', true) })
    expect(state.p).toBeGreaterThan(MASTERY.mastered)
    expect(state.mastered).toBe(false)
    state = learner.addEvidence(s.sessionId, s.conceptId, 'answer', { attemptId: s.answer(s.question('unaided'), 'correct', true) })
    expect(state.mastered).toBe(true)
    expect(learner.get(s.conceptId).band).toBe('mastered')
  })

  it('replays with the final grade after a contest and keeps the log append-only', () => {
    const db = openDatabase(':memory:')
    const s = seed(db)
    const learner = new LearnerRepo(db)
    const attemptId = s.answer(s.question('unaided'), 'incorrect', true)
    const before = learner.addEvidence(s.sessionId, s.conceptId, 'answer', { attemptId })
    db.prepare("INSERT INTO grades (attempt_id, pass, verdict, score, reason, graded_by) VALUES (?, 2, 'correct', 1, 'r', 'model')").run(attemptId)
    const after = learner.regrade(s.sessionId, s.conceptId, attemptId)
    expect(before.p).toBeCloseTo(replay([wrong('unaided')]), 10)
    expect(after.p).toBeCloseTo(replay([right('unaided')]), 10)
    const history = learner.history(s.conceptId)
    expect(history.map((h) => h.kind)).toEqual(['answer', 'regrade'])
    expect(history[1]?.pBefore).toBeCloseTo(before.p, 10)
    expect(history[1]?.pAfter).toBeCloseTo(after.p, 10)
  })

  it('reports no evidence as no band', () => {
    const db = openDatabase(':memory:')
    const s = seed(db)
    const learner = new LearnerRepo(db)
    expect(learner.get(s.conceptId)).toMatchObject({ p: MASTERY.prior, evidence: 0, band: null })
    expect(learner.addEvidence(s.sessionId, s.conceptId, 'inferred-new').band).toBe('new')
  })
})
