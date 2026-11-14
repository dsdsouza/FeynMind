import type Database from 'better-sqlite3'

export interface Migration {
  /** Sequential, starting at 1. Never edit or renumber a migration that has shipped. */
  version: number
  name: string
  up: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'create_settings',
    up: `
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY NOT NULL,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;
    `
  },
  {
    version: 2,
    name: 'create_sessions_and_ingestion',
    // Every table carries session_id so several sessions can share one database later.
    // Page positions: page_index is 1-based within the file; y values are measured in PDF units
    // from the top of the page. The vector size (384) belongs to the embedding model; changing the
    // model needs a new migration.
    up: `
      CREATE TABLE sessions (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      CREATE TABLE materials (
        id             INTEGER PRIMARY KEY,
        session_id     INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sha256         TEXT NOT NULL,
        original_name  TEXT NOT NULL,
        stored_name    TEXT NOT NULL,
        kind           TEXT NOT NULL CHECK (kind IN ('pdf', 'pptx')),
        byte_size      INTEGER NOT NULL,
        page_count     INTEGER,
        structure      TEXT CHECK (structure IN ('outline', 'headings', 'slides')),
        body_font_size REAL,
        numbered_headings INTEGER,
        status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'done', 'failed')),
        error          TEXT,
        extract_ms     INTEGER NOT NULL DEFAULT 0,
        ocr_ms         INTEGER NOT NULL DEFAULT 0,
        embed_ms       INTEGER NOT NULL DEFAULT 0,
        added_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        started_at     TEXT,
        read_at        TEXT,
        finished_at    TEXT,
        UNIQUE (session_id, sha256)
      ) STRICT;

      CREATE TABLE pages (
        session_id     INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        material_id    INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        page_index     INTEGER NOT NULL,
        page_label     TEXT,
        status         TEXT NOT NULL CHECK (status IN ('done', 'failed')),
        method         TEXT CHECK (method IN ('text', 'ocr', 'slide', 'empty')),
        text           TEXT NOT NULL DEFAULT '',
        lines          TEXT NOT NULL DEFAULT '[]',
        height         REAL NOT NULL DEFAULT 0,
        scanned        INTEGER NOT NULL DEFAULT 0,
        math_heavy     INTEGER NOT NULL DEFAULT 0,
        figure_heavy   INTEGER NOT NULL DEFAULT 0,
        ocr_confidence REAL,
        error          TEXT,
        PRIMARY KEY (material_id, page_index)
      ) STRICT;

      CREATE TABLE sections (
        id          INTEGER PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        ordinal     INTEGER NOT NULL,
        chapter     TEXT,
        section     TEXT,
        start_page  INTEGER NOT NULL,
        start_y     REAL NOT NULL DEFAULT 0,
        source      TEXT NOT NULL CHECK (source IN ('outline', 'headings', 'slides', 'whole')),
        chunked     INTEGER NOT NULL DEFAULT 0,
        UNIQUE (material_id, ordinal)
      ) STRICT;

      CREATE TABLE chunks (
        id          INTEGER PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        section_id  INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
        ordinal     INTEGER NOT NULL,
        chapter     TEXT,
        section     TEXT,
        page_start  INTEGER NOT NULL,
        page_end    INTEGER NOT NULL,
        text        TEXT NOT NULL,
        embedded    INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX chunks_by_section ON chunks (section_id);
      CREATE INDEX chunks_to_embed ON chunks (material_id, id) WHERE embedded = 0;

      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        chapter, section, text,
        content = 'chunks', content_rowid = 'id', tokenize = 'porter unicode61'
      );
      CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts (rowid, chapter, section, text) VALUES (new.id, new.chapter, new.section, new.text);
      END;
      CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts (chunks_fts, rowid, chapter, section, text)
          VALUES ('delete', old.id, old.chapter, old.section, old.text);
        DELETE FROM chunk_vectors WHERE chunk_id = old.id;
      END;

      CREATE VIRTUAL TABLE chunk_vectors USING vec0(
        chunk_id   INTEGER PRIMARY KEY,
        session_id INTEGER PARTITION KEY,
        embedding  FLOAT[384] distance_metric = cosine
      );
    `
  },
  {
    version: 3,
    name: 'knowledge',
    // Milestone 3: model cache and ledger, syllabus and units, page transcriptions, knowledge jobs
    // and the concept graph. Chunks gain the original words of re-transcribed text, and keyword
    // search indexes them too, so the full-text index is rebuilt with the new column.
    up: `
      ALTER TABLE sessions ADD COLUMN call_cap INTEGER DEFAULT 100;
      ALTER TABLE sessions ADD COLUMN spend_cap_usd REAL;

      CREATE TABLE model_cache (
        key            TEXT PRIMARY KEY NOT NULL,
        prompt         TEXT NOT NULL,
        prompt_version INTEGER NOT NULL,
        model          TEXT NOT NULL,
        response       TEXT NOT NULL,
        input_tokens   INTEGER NOT NULL,
        output_tokens  INTEGER NOT NULL,
        created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      CREATE TABLE syllabi (
        id           INTEGER PRIMARY KEY,
        session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_name  TEXT NOT NULL,
        sha256       TEXT NOT NULL,
        text         TEXT NOT NULL,
        draft        TEXT,
        status       TEXT NOT NULL CHECK (status IN ('awaiting-approval', 'reading', 'draft', 'confirmed')),
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        confirmed_at TEXT
      ) STRICT;

      CREATE TABLE units (
        id          INTEGER PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        syllabus_id INTEGER NOT NULL REFERENCES syllabi(id) ON DELETE CASCADE,
        ordinal     INTEGER NOT NULL,
        title       TEXT NOT NULL,
        topics      TEXT NOT NULL DEFAULT '[]',
        start_date  TEXT,
        end_date    TEXT,
        exam_weight REAL,
        UNIQUE (syllabus_id, ordinal)
      ) STRICT;

      CREATE TABLE unit_sections (
        unit_id    INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
        section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
        PRIMARY KEY (unit_id, section_id)
      ) STRICT;

      CREATE TABLE exams (
        id          INTEGER PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        syllabus_id INTEGER NOT NULL REFERENCES syllabi(id) ON DELETE CASCADE,
        ordinal     INTEGER NOT NULL,
        title       TEXT NOT NULL,
        date        TEXT,
        weight      REAL
      ) STRICT;

      CREATE TABLE exam_units (
        exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
        PRIMARY KEY (exam_id, unit_id)
      ) STRICT;

      CREATE TABLE knowledge_jobs (
        id           INTEGER PRIMARY KEY,
        session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL CHECK (kind IN ('syllabus', 'unit')),
        unit_id      INTEGER REFERENCES units(id) ON DELETE CASCADE,
        syllabus_id  INTEGER REFERENCES syllabi(id) ON DELETE CASCADE,
        model        TEXT NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('awaiting-approval', 'running', 'paused', 'done', 'failed', 'cancelled')),
        pause_reason TEXT,
        resume_at    TEXT,
        error        TEXT,
        estimate     TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        approved_at  TEXT,
        finished_at  TEXT
      ) STRICT;

      CREATE TABLE job_steps (
        id          INTEGER PRIMARY KEY,
        job_id      INTEGER NOT NULL REFERENCES knowledge_jobs(id) ON DELETE CASCADE,
        ordinal     INTEGER NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('syllabus-parse', 'syllabus-map', 'transcribe', 'rechunk', 'extract', 'match', 'build')),
        material_id INTEGER,
        page_index  INTEGER,
        section_id  INTEGER,
        status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
        error       TEXT,
        UNIQUE (job_id, ordinal)
      ) STRICT;

      -- Every model request: billed calls, cache hits, and refused or failed attempts.
      CREATE TABLE model_calls (
        id                INTEGER PRIMARY KEY,
        session_id        INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
        job_id            INTEGER REFERENCES knowledge_jobs(id) ON DELETE SET NULL,
        prompt            TEXT NOT NULL,
        model             TEXT NOT NULL,
        cache_key         TEXT,
        outcome           TEXT NOT NULL CHECK (outcome IN ('ok', 'cache-hit', 'invalid', 'rate-limited', 'quota', 'error')),
        input_tokens      INTEGER NOT NULL DEFAULT 0,
        output_tokens     INTEGER NOT NULL DEFAULT 0,
        thinking_tokens   INTEGER NOT NULL DEFAULT 0,
        est_input_tokens  INTEGER,
        est_output_tokens INTEGER,
        created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;
      CREATE INDEX model_calls_by_session ON model_calls (session_id);
      CREATE INDEX model_calls_by_job ON model_calls (job_id);
      CREATE INDEX model_calls_by_prompt ON model_calls (prompt, model, id);

      -- A vision model's reading of a page. The page's own text in pages stays as extracted.
      -- blocks: [{ fromLine, text }] where fromLine is the index of the extracted line it starts at.
      CREATE TABLE page_transcripts (
        session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        material_id INTEGER NOT NULL,
        page_index  INTEGER NOT NULL,
        blocks      TEXT NOT NULL,
        text        TEXT NOT NULL,
        cache_key   TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (material_id, page_index),
        FOREIGN KEY (material_id, page_index) REFERENCES pages(material_id, page_index) ON DELETE CASCADE
      ) STRICT;

      ALTER TABLE chunks ADD COLUMN original_text TEXT;
      DROP TRIGGER chunks_fts_insert;
      DROP TRIGGER chunks_fts_delete;
      DROP TABLE chunks_fts;
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        chapter, section, text, original_text,
        content = 'chunks', content_rowid = 'id', tokenize = 'porter unicode61'
      );
      CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts (rowid, chapter, section, text, original_text)
          VALUES (new.id, new.chapter, new.section, new.text, new.original_text);
      END;
      CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts (chunks_fts, rowid, chapter, section, text, original_text)
          VALUES ('delete', old.id, old.chapter, old.section, old.text, old.original_text);
        DELETE FROM chunk_vectors WHERE chunk_id = old.id;
      END;
      INSERT INTO chunks_fts (chunks_fts) VALUES ('rebuild');

      CREATE TABLE concepts (
        id               INTEGER PRIMARY KEY,
        session_id       INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name             TEXT NOT NULL,
        definition       TEXT NOT NULL,
        -- Where the concept first appears, for book order.
        first_material_id INTEGER NOT NULL,
        first_page       INTEGER NOT NULL,
        edited           INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      CREATE TABLE concept_pages (
        concept_id  INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        page_index  INTEGER NOT NULL,
        PRIMARY KEY (concept_id, material_id, page_index)
      ) STRICT;

      CREATE TABLE concept_units (
        concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        unit_id    INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
        PRIMARY KEY (concept_id, unit_id)
      ) STRICT;

      CREATE TABLE concept_prereqs (
        concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        prereq_id  INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        source     TEXT NOT NULL CHECK (source IN ('extracted', 'user')),
        status     TEXT NOT NULL CHECK (status IN ('active', 'removed-cycle', 'removed-user')),
        reason     TEXT,
        PRIMARY KEY (concept_id, prereq_id),
        CHECK (concept_id != prereq_id)
      ) STRICT;
      CREATE INDEX concept_prereqs_by_prereq ON concept_prereqs (prereq_id);

      -- Prerequisite names from extraction that matched no concept.
      CREATE TABLE concept_unresolved (
        concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        PRIMARY KEY (concept_id, name)
      ) STRICT;

      -- What extraction found in each section, before merging. Replaced when the section is extracted again.
      CREATE TABLE concept_mentions (
        id            INTEGER PRIMARY KEY,
        session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        section_id    INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
        ordinal       INTEGER NOT NULL,
        name          TEXT NOT NULL,
        definition    TEXT NOT NULL,
        pages         TEXT NOT NULL,
        prerequisites TEXT NOT NULL,
        cache_key     TEXT NOT NULL,
        concept_id    INTEGER REFERENCES concepts(id) ON DELETE SET NULL,
        UNIQUE (section_id, ordinal)
      ) STRICT;

      CREATE VIRTUAL TABLE concept_vectors USING vec0(
        concept_id INTEGER PRIMARY KEY,
        session_id INTEGER PARTITION KEY,
        embedding  FLOAT[384] distance_metric = cosine
      );
      CREATE TRIGGER concepts_delete AFTER DELETE ON concepts BEGIN
        DELETE FROM concept_vectors WHERE concept_id = old.id;
      END;
    `
  },
  {
    version: 4,
    name: 'tutor',
    // Milestone 4: questions with their rubrics, lessons, the diagnostic, every answer and grade,
    // and mastery with its evidence log. Answers and grades are kept in full (with times) so that
    // review scheduling can be derived from them later without changing these tables.
    up: `
      -- Generated questions, reused instead of generated again. criteria is the rubric:
      -- [{ id, text, points, essential, pages }]. sources: the passages it was written from.
      CREATE TABLE questions (
        id               INTEGER PRIMARY KEY,
        session_id       INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        concept_id       INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        kind             TEXT NOT NULL CHECK (kind IN ('diagnostic', 'opening', 'guided', 'partial', 'unaided')),
        ordinal          INTEGER NOT NULL,
        stem             TEXT NOT NULL,
        choices          TEXT,
        answer_index     INTEGER,
        explanation      TEXT,
        reference_answer TEXT,
        criteria         TEXT NOT NULL DEFAULT '[]',
        scaffold         TEXT,
        pages            TEXT NOT NULL DEFAULT '[]',
        sources          TEXT NOT NULL DEFAULT '[]',
        outside_sources  INTEGER NOT NULL DEFAULT 0,
        prompt           TEXT NOT NULL,
        prompt_version   INTEGER NOT NULL,
        cache_key        TEXT NOT NULL,
        created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (concept_id, kind, ordinal)
      ) STRICT;

      -- One lesson per concept. step is where the learner is; question_id the question shown.
      -- passages: the textbook passages retrieved once for the lesson and used by all its requests.
      CREATE TABLE lessons (
        id                  INTEGER PRIMARY KEY,
        session_id          INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        concept_id          INTEGER NOT NULL UNIQUE REFERENCES concepts(id) ON DELETE CASCADE,
        step                TEXT NOT NULL CHECK (step IN ('opening', 'explain', 'guided', 'partial', 'unaided', 'done')),
        question_id         INTEGER REFERENCES questions(id) ON DELETE SET NULL,
        question_shown_at   TEXT,
        passages            TEXT NOT NULL DEFAULT '[]',
        explanation         TEXT,
        explanation_outside INTEGER NOT NULL DEFAULT 0,
        draft_answer        TEXT NOT NULL DEFAULT '',
        started_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        finished_at         TEXT
      ) STRICT;

      -- A diagnostic quiz, or the quick check that confirms "I know this unit".
      CREATE TABLE diagnostics (
        id          INTEGER PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('diagnostic', 'confirm')),
        unit_id     INTEGER REFERENCES units(id) ON DELETE CASCADE,
        status      TEXT NOT NULL CHECK (status IN ('in-progress', 'done', 'abandoned')),
        started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        finished_at TEXT
      ) STRICT;

      -- Every answer, saved before it is graded. status 'saved' means not graded yet.
      CREATE TABLE attempts (
        id            INTEGER PRIMARY KEY,
        session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        concept_id    INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        question_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        lesson_id     INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
        diagnostic_id INTEGER REFERENCES diagnostics(id) ON DELETE CASCADE,
        answer_text   TEXT NOT NULL DEFAULT '',
        choice_index  INTEGER,
        skipped       INTEGER NOT NULL DEFAULT 0,
        shown_at      TEXT NOT NULL,
        submitted_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        status        TEXT NOT NULL CHECK (status IN ('saved', 'graded', 'failed')),
        error         TEXT,
        -- A contest: the objection is saved before the second grading, which is pending until grade pass 2 exists.
        objection     TEXT,
        objection_at  TEXT,
        CHECK ((lesson_id IS NULL) != (diagnostic_id IS NULL))
      ) STRICT;
      CREATE INDEX attempts_by_concept ON attempts (concept_id, id);
      CREATE INDEX attempts_by_lesson ON attempts (lesson_id, id);
      CREATE INDEX attempts_by_diagnostic ON attempts (diagnostic_id, id);

      -- Grades of an answer: pass 1 is the first grade, pass 2 the second grade after a contest.
      CREATE TABLE grades (
        id              INTEGER PRIMARY KEY,
        attempt_id      INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        pass            INTEGER NOT NULL CHECK (pass IN (1, 2)),
        verdict         TEXT NOT NULL CHECK (verdict IN ('correct', 'partial', 'incorrect')),
        score           REAL NOT NULL,
        criteria        TEXT NOT NULL DEFAULT '[]',
        reason          TEXT NOT NULL,
        feedback        TEXT NOT NULL DEFAULT '',
        pages           TEXT NOT NULL DEFAULT '[]',
        outside_sources INTEGER NOT NULL DEFAULT 0,
        objection       TEXT,
        assessment      TEXT,
        graded_by       TEXT NOT NULL CHECK (graded_by IN ('model', 'local')),
        model           TEXT,
        prompt_version  INTEGER,
        cache_key       TEXT,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (attempt_id, pass)
      ) STRICT;

      CREATE TABLE mastery (
        concept_id  INTEGER PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
        session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        p_known     REAL NOT NULL,
        evidence    INTEGER NOT NULL,
        mastered_at TEXT,
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      -- Append-only evidence. Mastery is recomputed by replaying it, using each answer's final grade.
      -- value: for overrides, the probability set; p_before/p_after as computed when the row was added.
      CREATE TABLE mastery_events (
        id         INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('diagnostic', 'inferred-known', 'inferred-new', 'answer', 'regrade', 'override-known', 'override-new')),
        attempt_id INTEGER REFERENCES attempts(id) ON DELETE CASCADE,
        value      REAL,
        p_before   REAL NOT NULL,
        p_after    REAL NOT NULL,
        at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;
      CREATE INDEX mastery_events_by_concept ON mastery_events (concept_id, id);

      -- The learner's corrections to a unit's standing, and how the confirming check went.
      CREATE TABLE unit_overrides (
        id            INTEGER PRIMARY KEY,
        session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        unit_id       INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
        claimed       TEXT NOT NULL CHECK (claimed IN ('known', 'new')),
        diagnostic_id INTEGER REFERENCES diagnostics(id) ON DELETE SET NULL,
        outcome       TEXT NOT NULL CHECK (outcome IN ('pending', 'confirmed', 'not-confirmed', 'accepted')),
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;
    `
  },
  {
    version: 5,
    name: 'reasoning',
    // Milestone 5: the learner's reasoning ("Your thinking"), typed or dictated, saved and graded
    // with the answer. Only text is stored; audio never is.
    up: `
      ALTER TABLE lessons ADD COLUMN draft_reasoning TEXT NOT NULL DEFAULT '';
      ALTER TABLE attempts ADD COLUMN reasoning_text TEXT NOT NULL DEFAULT '';
      -- What the grader made of the reasoning: 'sound', 'flawed', or 'none' (text that gives no
      -- reasoning to judge, such as "I think so"). NULL when the answer had no reasoning text.
      ALTER TABLE grades ADD COLUMN reasoning_judgment TEXT CHECK (reasoning_judgment IN ('sound', 'flawed', 'none'));
      ALTER TABLE grades ADD COLUMN reasoning_comment TEXT;
    `
  }
]

/**
 * Applies every migration newer than the database's user_version, each in its own transaction.
 * Returns the versions that were applied.
 */
export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): number[] {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Migrations must be numbered 1..n in order; found ${m.version} at position ${i + 1}`)
    }
  })

  const current = db.pragma('user_version', { simple: true }) as number
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this app supports (${migrations.length}). Update FeynMind.`
    )
  }

  const applied: number[] = []
  for (const m of migrations.slice(current)) {
    db.transaction(() => {
      db.exec(m.up)
      db.pragma(`user_version = ${m.version}`)
    })()
    applied.push(m.version)
  }
  return applied
}
