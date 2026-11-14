import type Database from 'better-sqlite3'
import { bandOf, isMastered, MASTERY, masteryGap, replay, scoreOf, shownEstimate, type Band, type Evidence, type LessonRecord, type MasteryGap, type QuestionKind } from './mastery'

export type EventKind = 'diagnostic' | 'inferred-known' | 'inferred-new' | 'answer' | 'regrade' | 'override-known' | 'override-new'
type Verdict = 'correct' | 'partial' | 'incorrect'

export interface ConceptMastery {
  conceptId: number
  p: number
  /** Pieces of evidence so far; 0 means nothing is known about this concept yet. */
  evidence: number
  mastered: boolean
  band: Band | null
  /** What mastery still needs when the estimate is at the threshold; see masteryGap. */
  gap: MasteryGap
  /** The estimate to display: capped just below the threshold until the concept is mastered. */
  shown: number
}

interface EventRow {
  kind: EventKind
  value: number | null
  questionKind: QuestionKind | null
  verdict: Verdict | null
}

/**
 * Mastery estimates and their evidence log. The estimate is always the replay of a concept's
 * evidence in order, using each answer's final grade, so a regrade after a contest simply
 * recomputes it. The log is append-only.
 */
export class LearnerRepo {
  constructor(private readonly db: Database.Database) {}

  /** Adds evidence for a concept and recomputes its estimate. Returns the new state. */
  addEvidence(sessionId: number, conceptId: number, kind: Exclude<EventKind, 'regrade'>, extra: { attemptId?: number; value?: number } = {}): ConceptMastery {
    return this.db.transaction(() => this.append(sessionId, conceptId, kind, extra.attemptId ?? null, extra.value ?? null))()
  }

  /** Records that an answer's grade changed (after a contest) and recomputes the estimate. */
  regrade(sessionId: number, conceptId: number, attemptId: number): ConceptMastery {
    return this.db.transaction(() => this.append(sessionId, conceptId, 'regrade', attemptId, null))()
  }

  private append(sessionId: number, conceptId: number, kind: EventKind, attemptId: number | null, value: number | null): ConceptMastery {
    const before = this.get(conceptId).p
    this.db
      .prepare('INSERT INTO mastery_events (session_id, concept_id, kind, attempt_id, value, p_before, p_after) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, conceptId, kind, attemptId, value, before, before)
    const eventId = Number(this.db.prepare('SELECT last_insert_rowid() AS id').pluck().get())
    const state = this.recompute(sessionId, conceptId)
    this.db.prepare('UPDATE mastery_events SET p_after = ? WHERE id = ?').run(state.p, eventId)
    return state
  }

  private recompute(sessionId: number, conceptId: number): ConceptMastery {
    const rows = this.db
      .prepare<[number], EventRow>(
        `SELECT e.kind, e.value, q.kind AS questionKind,
           (SELECT g.verdict FROM grades g WHERE g.attempt_id = e.attempt_id ORDER BY g.pass DESC LIMIT 1) AS verdict
         FROM mastery_events e
         LEFT JOIN attempts a ON a.id = e.attempt_id
         LEFT JOIN questions q ON q.id = a.question_id
         WHERE e.concept_id = ? AND e.kind != 'regrade' ORDER BY e.id`
      )
      .all(conceptId)
    const evidence = rows.map(toEvidence).filter((e): e is Evidence => e !== null)
    const p = replay(evidence)
    const lesson = this.lessonRecord(conceptId)
    const mastered = isMastered(p, lesson)
    const previous = this.db.prepare<[number], { masteredAt: string | null }>('SELECT mastered_at AS masteredAt FROM mastery WHERE concept_id = ?').get(conceptId)
    this.db
      .prepare(
        `INSERT INTO mastery (concept_id, session_id, p_known, evidence, mastered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (concept_id) DO UPDATE SET p_known = excluded.p_known, evidence = excluded.evidence,
           mastered_at = excluded.mastered_at, updated_at = excluded.updated_at`
      )
      .run(conceptId, sessionId, p, rows.length, mastered ? (previous?.masteredAt ?? new Date().toISOString()) : null)
    return { conceptId, p, evidence: rows.length, mastered, band: rows.length === 0 ? null : bandOf(p, mastered), gap: masteryGap(p, lesson), shown: shownEstimate(p, mastered) }
  }

  /** Whether the lesson has a correct unaided answer, and the final verdict of its last graded answer. */
  private lessonRecord(conceptId: number): LessonRecord {
    const rows = this.db
      .prepare<[number], { kind: QuestionKind; verdict: Verdict }>(
        `SELECT q.kind, (SELECT g.verdict FROM grades g WHERE g.attempt_id = a.id ORDER BY g.pass DESC LIMIT 1) AS verdict
         FROM attempts a JOIN questions q ON q.id = a.question_id
         WHERE a.concept_id = ? AND a.lesson_id IS NOT NULL AND a.status = 'graded' ORDER BY a.id`
      )
      .all(conceptId)
    return {
      unaidedCorrect: rows.some((r) => r.kind === 'unaided' && r.verdict === 'correct'),
      lastVerdict: rows[rows.length - 1]?.verdict ?? null
    }
  }

  get(conceptId: number): ConceptMastery {
    const row = this.db
      .prepare<[number], { p: number; evidence: number; masteredAt: string | null }>('SELECT p_known AS p, evidence, mastered_at AS masteredAt FROM mastery WHERE concept_id = ?')
      .get(conceptId)
    if (!row) return { conceptId, p: MASTERY.prior, evidence: 0, mastered: false, band: null, gap: null, shown: MASTERY.prior }
    const mastered = row.masteredAt !== null
    const gap = mastered ? null : masteryGap(row.p, this.lessonRecord(conceptId))
    return { conceptId, p: row.p, evidence: row.evidence, mastered, band: row.evidence === 0 ? null : bandOf(row.p, mastered), gap, shown: shownEstimate(row.p, mastered) }
  }

  /** Mastery of several concepts; concepts without evidence get the prior. */
  many(conceptIds: number[]): Map<number, ConceptMastery> {
    return new Map(conceptIds.map((id) => [id, this.get(id)]))
  }

  /** Every evidence row of a concept, oldest first, for display and for later scheduling. */
  history(conceptId: number): { kind: EventKind; attemptId: number | null; pBefore: number; pAfter: number; at: string }[] {
    return this.db
      .prepare<[number], { kind: EventKind; attemptId: number | null; pBefore: number; pAfter: number; at: string }>(
        'SELECT kind, attempt_id AS attemptId, p_before AS pBefore, p_after AS pAfter, at FROM mastery_events WHERE concept_id = ? ORDER BY id'
      )
      .all(conceptId)
  }
}

function toEvidence(row: EventRow): Evidence | null {
  switch (row.kind) {
    case 'diagnostic':
    case 'answer':
      if (!row.questionKind || !row.verdict) return null
      return { kind: 'answer', question: row.questionKind, score: scoreOf(row.verdict) }
    case 'inferred-known':
      return { kind: 'inferred-known' }
    case 'inferred-new':
      return { kind: 'inferred-new' }
    case 'override-known':
      return { kind: 'override', direction: 'known', value: row.value ?? MASTERY.overrideKnown }
    case 'override-new':
      return { kind: 'override', direction: 'new', value: row.value ?? MASTERY.prior }
    case 'regrade':
      return null
  }
}
