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
