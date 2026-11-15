import type Database from 'better-sqlite3'
import { systemClock, type AppClock } from '../clock'
import { studyDay } from './days'
import { bandOf, MASTERY, masteryStatus, scoreOf, shownEstimate, type Band, type Evidence, type LessonRecord, type MasteryGap, type QuestionKind } from './mastery'
import { learnedRating, replayCard, reviewRating, type LessonAnswer, type ReviewRating, type ScheduleEvent } from './schedule'

export type EventKind = 'diagnostic' | 'inferred-known' | 'inferred-new' | 'answer' | 'regrade' | 'override-known' | 'override-new'
type Verdict = 'correct' | 'partial' | 'incorrect'
type Judgment = 'sound' | 'flawed' | 'none'
type Purpose = 'lesson' | 'review' | 'reteach'

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
  /** Learned, then a review lapsed, and not mastered again since. */
  lapsed: boolean
}

/** A learned concept's memory state, as stored. */
export interface ReviewCard {
  conceptId: number
  sessionId: number
  dueDay: string
  stability: number
  difficulty: number
  reps: number
  lapses: number
  lastDay: string
  learnedDay: string
  learnedAt: string
  /** The last review was rated Again. */
  lapsed: boolean
}

interface EventRow {
  kind: EventKind
  value: number | null
  questionKind: QuestionKind | null
  purpose: Purpose | null
  hintUsed: number | null
  skipped: number | null
  verdict: Verdict | null
  judgment: Judgment | null
}

const CARD_COLUMNS = `concept_id AS conceptId, session_id AS sessionId, due_day AS dueDay, stability, difficulty, reps, lapses, last_day AS lastDay,
  learned_day AS learnedDay, learned_at AS learnedAt, lapsed`
type RawCard = Omit<ReviewCard, 'lapsed'> & { lapsed: number }
const toCard = (r: RawCard): ReviewCard => ({ ...r, lapsed: r.lapsed === 1 })

const FINAL_VERDICT = '(SELECT g.verdict FROM grades g WHERE g.attempt_id = a.id ORDER BY g.pass DESC LIMIT 1)'
const FINAL_JUDGMENT = '(SELECT g.reasoning_judgment FROM grades g WHERE g.attempt_id = a.id ORDER BY g.pass DESC LIMIT 1)'

/**
 * Mastery estimates with their evidence log, and review schedules with theirs. The estimate is
 * always the replay of a concept's evidence in order, using each answer's final grade, and the
 * schedule is the replay of its review events, rated from final grades too, so a regrade after a
 * contest simply recomputes both. Both logs are append-only. Times written here come from the
 * scheduling clock, never from the system time.
 */
export class LearnerRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: AppClock = systemClock
  ) {}

  private nowIso(): string {
    const now = this.clock.now()
    this.clock.recordWrite(now)
    return new Date(now).toISOString()
  }

  /** Adds evidence for a concept and recomputes its estimate. Returns the new state. */
  addEvidence(sessionId: number, conceptId: number, kind: Exclude<EventKind, 'regrade'>, extra: { attemptId?: number; value?: number } = {}): ConceptMastery {
    return this.db.transaction(() => this.append(sessionId, conceptId, kind, extra.attemptId ?? null, extra.value ?? null))()
  }

  /** Records that an answer's grade changed (after a contest) and recomputes the estimate and schedule. */
  regrade(sessionId: number, conceptId: number, attemptId: number): ConceptMastery {
    return this.db.transaction(() => this.append(sessionId, conceptId, 'regrade', attemptId, null))()
  }

  private append(sessionId: number, conceptId: number, kind: EventKind, attemptId: number | null, value: number | null): ConceptMastery {
    const before = this.get(conceptId).p
    const at = this.nowIso()
    this.db
      .prepare('INSERT INTO mastery_events (session_id, concept_id, kind, attempt_id, value, p_before, p_after, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, conceptId, kind, attemptId, value, before, before, at)
    const eventId = Number(this.db.prepare('SELECT last_insert_rowid() AS id').pluck().get())
    const state = this.recompute(sessionId, conceptId, attemptId)
    this.db.prepare('UPDATE mastery_events SET p_after = ? WHERE id = ?').run(state.p, eventId)
    return state
  }

  private evidenceRows(conceptId: number): EventRow[] {
    return this.db
      .prepare<[number], EventRow>(
        `SELECT e.kind, e.value, q.kind AS questionKind, a.purpose, a.hint_used AS hintUsed, a.skipped,
           ${FINAL_VERDICT} AS verdict, ${FINAL_JUDGMENT} AS judgment
         FROM mastery_events e
         LEFT JOIN attempts a ON a.id = e.attempt_id
         LEFT JOIN questions q ON q.id = a.question_id
         WHERE e.concept_id = ? AND e.kind != 'regrade' ORDER BY e.id`
      )
      .all(conceptId)
  }

  private isLearned(conceptId: number): boolean {
    return this.db.prepare("SELECT 1 FROM review_events WHERE concept_id = ? AND kind = 'learned'").get(conceptId) !== undefined
  }

  private status(conceptId: number): { rows: EventRow[]; p: number; mastered: boolean; gap: MasteryGap; lapsed: boolean } {
    const rows = this.evidenceRows(conceptId)
    const evidence = rows.map(toEvidence).filter((e): e is Evidence => e !== null)
    return { rows, ...masteryStatus(evidence, this.lessonRecord(conceptId), this.isLearned(conceptId)) }
  }

  private recompute(sessionId: number, conceptId: number, attemptId: number | null): ConceptMastery {
    let s = this.status(conceptId)
    // First mastery is first learning: the concept gets a review schedule from now on.
    if (s.mastered && !this.isLearned(conceptId)) {
      const at = this.nowIso()
      this.db
        .prepare("INSERT INTO review_events (session_id, concept_id, kind, attempt_id, at, day) VALUES (?, ?, 'learned', ?, ?, ?)")
        .run(sessionId, conceptId, attemptId, at, studyDay(Date.parse(at), this.clock.timeZone()))
      s = this.status(conceptId)
    }
    const previous = this.db.prepare<[number], { masteredAt: string | null }>('SELECT mastered_at AS masteredAt FROM mastery WHERE concept_id = ?').get(conceptId)
    const masteredAt = s.mastered ? (previous?.masteredAt ?? this.nowIso()) : null
    this.db
      .prepare(
        `INSERT INTO mastery (concept_id, session_id, p_known, evidence, mastered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (concept_id) DO UPDATE SET p_known = excluded.p_known, evidence = excluded.evidence,
           mastered_at = excluded.mastered_at, updated_at = excluded.updated_at`
      )
      .run(conceptId, sessionId, s.p, s.rows.length, masteredAt, this.nowIso())
    this.rebuildCard(conceptId)
    return this.view(conceptId, s.p, s.rows.length, s.mastered, s.gap, s.lapsed)
  }

  private view(conceptId: number, p: number, evidence: number, mastered: boolean, gap: MasteryGap, lapsed: boolean): ConceptMastery {
    return { conceptId, p, evidence, mastered, band: evidence === 0 ? null : bandOf(p, mastered), gap, shown: shownEstimate(p, mastered), lapsed }
  }

  /** Whether the lesson has a correct unaided answer, and the final verdict of its last graded answer. Lesson answers only. */
  private lessonRecord(conceptId: number): LessonRecord {
    const rows = this.db
      .prepare<[number], { kind: QuestionKind; verdict: Verdict }>(
        `SELECT q.kind, ${FINAL_VERDICT} AS verdict
         FROM attempts a JOIN questions q ON q.id = a.question_id
         WHERE a.concept_id = ? AND a.lesson_id IS NOT NULL AND a.purpose = 'lesson' AND a.status = 'graded' ORDER BY a.id`
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
    if (!row) return this.view(conceptId, MASTERY.prior, 0, false, null, false)
    const mastered = row.masteredAt !== null
    if (mastered) return this.view(conceptId, row.p, row.evidence, true, null, false)
    const s = this.status(conceptId)
    return this.view(conceptId, row.p, row.evidence, false, s.gap, s.lapsed)
  }

  /** Mastery of several concepts; concepts without evidence get the prior. */
  many(conceptIds: number[]): Map<number, ConceptMastery> {
    return new Map(conceptIds.map((id) => [id, this.get(id)]))
  }

  /** Every evidence row of a concept, oldest first, for display. */
  history(conceptId: number): { kind: EventKind; attemptId: number | null; pBefore: number; pAfter: number; at: string }[] {
    return this.db
      .prepare<[number], { kind: EventKind; attemptId: number | null; pBefore: number; pAfter: number; at: string }>(
        'SELECT kind, attempt_id AS attemptId, p_before AS pBefore, p_after AS pAfter, at FROM mastery_events WHERE concept_id = ? ORDER BY id'
      )
      .all(conceptId)
  }

  // Review scheduling

  /**
   * Records a review answer in the scheduling log when it is submitted, with the study day it was
   * given on. It counts once it is graded (so an answer given offline schedules from the day it
   * was given, not the day it was graded).
   */
  recordReview(sessionId: number, conceptId: number, attemptId: number, submittedAt: string): void {
    this.db
      .prepare("INSERT INTO review_events (session_id, concept_id, kind, attempt_id, at, day) VALUES (?, ?, 'review', ?, ?, ?)")
      .run(sessionId, conceptId, attemptId, submittedAt, studyDay(Date.parse(submittedAt), this.clock.timeZone()))
  }

  /** The rated events of a concept's schedule, in order; reviews not graded yet are left out. */
  scheduleEvents(conceptId: number): (ScheduleEvent & { kind: 'learned' | 'review'; attemptId: number | null })[] {
    const rows = this.db
      .prepare<[number], { kind: 'learned' | 'review'; attemptId: number | null; at: string; day: string | null; verdict: Verdict | null; judgment: Judgment | null; hintUsed: number | null; skipped: number | null }>(
        `SELECT e.kind, e.attempt_id AS attemptId, e.at, e.day, ${FINAL_VERDICT} AS verdict, ${FINAL_JUDGMENT} AS judgment, a.hint_used AS hintUsed, a.skipped
         FROM review_events e LEFT JOIN attempts a ON a.id = e.attempt_id
         WHERE e.concept_id = ? ORDER BY e.id`
      )
      .all(conceptId)
    const out: (ScheduleEvent & { kind: 'learned' | 'review'; attemptId: number | null })[] = []
    for (const r of rows) {
      const day = r.day ?? studyDay(Date.parse(r.at), this.clock.timeZone())
      if (r.kind === 'learned') {
        out.push({ kind: 'learned', attemptId: r.attemptId, day, rating: this.learnedRatingOf(conceptId, r.attemptId) })
      } else if (r.verdict !== null) {
        const rating: ReviewRating = reviewRating({ verdict: r.verdict, reasoning: r.judgment, hintUsed: r.hintUsed === 1, skipped: r.skipped === 1 })
        out.push({ kind: 'review', attemptId: r.attemptId, day, rating })
      }
    }
    return out
  }

  private learnedRatingOf(conceptId: number, uptoAttempt: number | null): ReviewRating {
    const answers = this.db
      .prepare<[number, number], LessonAnswer>(
        `SELECT q.kind, ${FINAL_VERDICT} AS verdict FROM attempts a JOIN questions q ON q.id = a.question_id
         WHERE a.concept_id = ? AND a.purpose = 'lesson' AND a.lesson_id IS NOT NULL AND a.status = 'graded' AND a.id <= ? ORDER BY a.id`
      )
      .all(conceptId, uptoAttempt ?? Number.MAX_SAFE_INTEGER)
    return learnedRating(answers.filter((a) => a.verdict !== null))
  }

  /** Replays a concept's schedule into its stored card (removing the card when it has no events). */
  rebuildCard(conceptId: number): ReviewCard | null {
    const events = this.scheduleEvents(conceptId)
    const state = replayCard(events)
    if (!state) {
      this.db.prepare('DELETE FROM review_cards WHERE concept_id = ?').run(conceptId)
      return null
    }
    const learned = this.db
      .prepare<[number], { sessionId: number; at: string }>("SELECT session_id AS sessionId, at FROM review_events WHERE concept_id = ? AND kind = 'learned' ORDER BY id LIMIT 1")
      .get(conceptId)
    if (!learned) throw new Error('A concept with review events has no first learning.')
    this.db
      .prepare(
        `INSERT INTO review_cards (concept_id, session_id, due_day, stability, difficulty, reps, lapses, last_day, learned_day, learned_at, lapsed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (concept_id) DO UPDATE SET due_day = excluded.due_day, stability = excluded.stability, difficulty = excluded.difficulty,
           reps = excluded.reps, lapses = excluded.lapses, last_day = excluded.last_day, learned_day = excluded.learned_day,
           learned_at = excluded.learned_at, lapsed = excluded.lapsed`
      )
      .run(conceptId, learned.sessionId, state.dueDay, state.stability, state.difficulty, state.reps, state.lapses, state.lastDay, state.learnedDay, learned.at, state.lapsed ? 1 : 0)
    return this.card(conceptId) ?? null
  }

  /**
   * At startup: gives backfilled events (concepts mastered before review scheduling existed) their
   * study day in the current time zone, and builds every missing card. Idempotent.
   */
  prepareSchedules(): number {
    return this.db.transaction(() => {
      const undated = this.db.prepare<[], { id: number; at: string }>('SELECT id, at FROM review_events WHERE day IS NULL').all()
      for (const e of undated) this.db.prepare('UPDATE review_events SET day = ? WHERE id = ?').run(studyDay(Date.parse(e.at), this.clock.timeZone()), e.id)
      const missing = this.db
        .prepare<[], { conceptId: number }>('SELECT DISTINCT concept_id AS conceptId FROM review_events WHERE concept_id NOT IN (SELECT concept_id FROM review_cards)')
        .all()
      for (const m of missing) this.rebuildCard(m.conceptId)
      return missing.length
    })()
  }

  card(conceptId: number): ReviewCard | undefined {
    const row = this.db.prepare<[number], RawCard>(`SELECT ${CARD_COLUMNS} FROM review_cards WHERE concept_id = ?`).get(conceptId)
    return row ? toCard(row) : undefined
  }

  cards(sessionId: number): ReviewCard[] {
    return this.db.prepare<[number], RawCard>(`SELECT ${CARD_COLUMNS} FROM review_cards WHERE session_id = ? ORDER BY due_day, concept_id`).all(sessionId).map(toCard)
  }
}

function toEvidence(row: EventRow): Evidence | null {
  switch (row.kind) {
    case 'diagnostic':
    case 'answer': {
      if (!row.questionKind || !row.verdict) return null
      const score = scoreOf(row.verdict)
      if (row.purpose === 'review') {
        const lapse = reviewRating({ verdict: row.verdict, reasoning: row.judgment, hintUsed: row.hintUsed === 1, skipped: row.skipped === 1 }) === 'again'
        return { kind: 'answer', question: 'review', score, hint: row.hintUsed === 1, lapse }
      }
      return { kind: 'answer', question: row.questionKind, score }
    }
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
