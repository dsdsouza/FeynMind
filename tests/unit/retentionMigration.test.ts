import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { LearnerRepo } from '../../src/main/learner'
import { addDays } from '../../src/main/learner/days'
import { migrate, MIGRATIONS, openDatabase } from '../../src/main/storage'

const ZONE = 'America/New_York'
const clockAt = (iso: string) => ({ now: () => Date.parse(iso), timeZone: () => ZONE, recordWrite: () => undefined })

/** Tables a 0.1.0 database holds learning data in. Migration 6 must not change any of their rows. */
const TABLES = ['sessions', 'units', 'exams', 'exam_units', 'concepts', 'concept_units', 'concept_prereqs', 'lessons', 'questions', 'diagnostics', 'attempts', 'grades', 'mastery', 'mastery_events', 'unit_overrides', 'model_calls', 'model_cache']

function snapshot(db: Database.Database): Record<string, unknown[]> {
  return Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]))
}

/** The rows a learner who mastered one concept and started another would have in 0.1.0 (schema version 5). */
function seed010(db: Database.Database): { mastered: number; started: number } {
  const run = (sql: string, ...args: unknown[]) => Number(db.prepare(sql).run(...args).lastInsertRowid)
  const sid = run("INSERT INTO sessions (name) VALUES ('Linear algebra')")
  const mid = run("INSERT INTO materials (session_id, sha256, original_name, stored_name, kind, byte_size) VALUES (?, 'sha', 'b.pdf', 'sha.pdf', 'pdf', 1)", sid)
  const syl = run("INSERT INTO syllabi (session_id, source_name, sha256, text, status) VALUES (?, 's', 's', 's', 'confirmed')", sid)
  const unit = run("INSERT INTO units (session_id, syllabus_id, ordinal, title) VALUES (?, ?, 0, 'Vectors')", sid, syl)
  run("INSERT INTO exams (session_id, syllabus_id, ordinal, title, date) VALUES (?, ?, 0, 'Quiz 1', '2026-12-03')", sid, syl)
  const concept = (name: string) => {
    const id = run("INSERT INTO concepts (session_id, name, definition, first_material_id, first_page) VALUES (?, ?, 'd', ?, 1)", sid, name, mid)
    run('INSERT INTO concept_units (concept_id, unit_id) VALUES (?, ?)', id, unit)
    return id
  }
  const mastered = concept('vector')
  const started = concept('dot product')
  const lesson = (conceptId: number, step: string) => run("INSERT INTO lessons (session_id, concept_id, step, started_at) VALUES (?, ?, ?, '2026-11-14T13:00:00.000Z')", sid, conceptId, step)
  const question = (conceptId: number, kind: string, ordinal: number) =>
    run("INSERT INTO questions (session_id, concept_id, kind, ordinal, stem, prompt, prompt_version, cache_key) VALUES (?, ?, ?, ?, 'q', 'lesson-questions', 2, 'k')", sid, conceptId, kind, ordinal)
  let p = 0.2
  const answer = (conceptId: number, lessonId: number, kind: string, verdict: string, at: string) => {
    const q = question(conceptId, kind, kind === 'unaided' ? 1 : 0)
    const a = run("INSERT INTO attempts (session_id, concept_id, question_id, lesson_id, answer_text, shown_at, submitted_at, status) VALUES (?, ?, ?, ?, 'a', ?, ?, 'graded')", sid, conceptId, q, lessonId, at, at)
    run("INSERT INTO grades (attempt_id, pass, verdict, score, reason, graded_by) VALUES (?, 1, ?, 1, 'r', 'model')", a, verdict)
    run("INSERT INTO mastery_events (session_id, concept_id, kind, attempt_id, p_before, p_after, at) VALUES (?, ?, 'answer', ?, ?, ?, ?)", sid, conceptId, a, p, p, at)
  }
  const l1 = lesson(mastered, 'done')
  answer(mastered, l1, 'opening', 'incorrect', '2026-11-14T13:01:00.000Z')
  answer(mastered, l1, 'guided', 'correct', '2026-11-14T13:05:00.000Z')
  answer(mastered, l1, 'partial', 'correct', '2026-11-14T13:08:00.000Z')
  answer(mastered, l1, 'unaided', 'correct', '2026-11-14T13:10:00.000Z')
  run("INSERT INTO mastery (concept_id, session_id, p_known, evidence, mastered_at) VALUES (?, ?, 0.97, 4, '2026-11-14T13:10:01.000Z')", mastered, sid)
  const l2 = lesson(started, 'guided')
  answer(started, l2, 'opening', 'correct', '2026-11-14T13:20:00.000Z')
  run('INSERT INTO mastery (concept_id, session_id, p_known, evidence, mastered_at) VALUES (?, ?, 0.66, 1, NULL)', started, sid)
  return { mastered, started }
}

describe('migration 6 (retention)', () => {
  it('upgrades a 0.1.0 database without changing a row, and schedules what was mastered', () => {
    const db = openDatabase(':memory:', { migrate: false })
    migrate(db, MIGRATIONS.slice(0, 5))
    expect(db.pragma('user_version', { simple: true })).toBe(5)
    const { mastered, started } = seed010(db)
    const before = snapshot(db)

    expect(migrate(db)).toEqual([6])
    const after = snapshot(db)
    // Added columns appear with their defaults; every other value is untouched.
    const strip = (rows: unknown[]) => rows.map((r) => Object.fromEntries(Object.entries(r as object).filter(([k]) => !['purpose', 'hint', 'hint_used', 'review_item_id'].includes(k))))
    for (const t of TABLES) expect([t, strip(after[t] ?? [])]).toEqual([t, before[t]])
    expect(db.prepare('SELECT DISTINCT purpose FROM attempts').pluck().all()).toEqual(['lesson'])
    expect(db.prepare('SELECT DISTINCT purpose FROM questions').pluck().all()).toEqual(['lesson'])

    const learner = new LearnerRepo(db, clockAt('2026-11-15T15:00:00.000Z'))
    expect(learner.prepareSchedules()).toBe(1)
    expect(learner.prepareSchedules()).toBe(0)
    const card = learner.card(mastered)
    // Learned on 14 November (New York); missed only the opening question, so rated Good: due in 3 days.
    expect(card).toMatchObject({ learnedDay: '2026-11-14', dueDay: addDays('2026-11-14', 3), reps: 1, lapses: 0, lapsed: false })
    expect(learner.card(started)).toBeUndefined()
    expect(learner.get(mastered)).toMatchObject({ mastered: true, p: 0.97 })
    expect(learner.get(started)).toMatchObject({ mastered: false, p: 0.66 })
    // The estimate recomputed from the evidence is what 0.1.0 computed (the stored rows above are hand-seeded).
    const replayed = learner.regrade(1, started, Number(db.prepare('SELECT max(id) FROM attempts WHERE concept_id = ?').pluck().get(started)))
    expect(replayed.p).toBeCloseTo(0.2 * 0.9 / (0.2 * 0.9 + 0.8 * 0.15) + (1 - 0.2 * 0.9 / (0.2 * 0.9 + 0.8 * 0.15)) * 0.15, 6)
  })

  // Opt-in: FEYNMIND_MIGRATION_DB=<path to a 0.1.0 feynmind.db>. The file is copied to a temporary
  // folder first; the original is never opened.
  const real = process.env['FEYNMIND_MIGRATION_DB']
  it.skipIf(!real)('upgrades a copy of a real 0.1.0 database without losing anything', () => {
    const source = real as string
    const dir = mkdtempSync(join(tmpdir(), 'feynmind-migration-'))
    try {
      const copy = join(dir, 'feynmind.db')
      copyFileSync(source, copy)
      for (const suffix of ['-wal', '-shm']) if (existsSync(source + suffix)) copyFileSync(source + suffix, copy + suffix)
      const db = openDatabase(copy, { migrate: false })
      expect(db.pragma('user_version', { simple: true })).toBe(5)
      const before = snapshot(db)
      const masteredBefore = db.prepare<[], { conceptId: number; p: number; masteredAt: string }>('SELECT concept_id AS conceptId, p_known AS p, mastered_at AS masteredAt FROM mastery WHERE mastered_at IS NOT NULL').all()
      expect(migrate(db)).toEqual([6])
      const after = snapshot(db)
      for (const t of TABLES) expect([t, after[t]?.length]).toEqual([t, before[t]?.length])
      const learner = new LearnerRepo(db, clockAt(new Date().toISOString()))
      learner.prepareSchedules()
      const cards = learner.cards(Number(db.prepare('SELECT id FROM sessions ORDER BY id LIMIT 1').pluck().get()))
      expect(cards.map((c) => c.conceptId).sort()).toEqual(masteredBefore.map((m) => m.conceptId).sort())
      for (const m of masteredBefore) expect(learner.get(m.conceptId)).toMatchObject({ mastered: true, p: m.p })
      console.log(`Migrated ${source}: ${TABLES.map((t) => `${t} ${after[t]?.length}`).join(', ')}`)
      for (const c of cards) console.log(`  concept ${c.conceptId}: learned ${c.learnedDay}, due ${c.dueDay}, stability ${c.stability.toFixed(2)} days`)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
