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
