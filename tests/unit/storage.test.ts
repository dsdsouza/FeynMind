import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { loadVectorExtension, migrate, MIGRATIONS, openDatabase, SessionStore, SettingsStore } from '../../src/main/storage'

/** A bare connection with the vector extension, as migrations need it. */
function bareDb(): Database.Database {
  const db = new Database(':memory:')
  loadVectorExtension(db)
  return db
}

describe('migrations', () => {
  it('applies every migration to a new database and records the version', () => {
    const db = bareDb()
    expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.version))
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL")
      .all()
      .map((t) => t.name)
    for (const name of ['settings', 'sessions', 'materials', 'pages', 'sections', 'chunks', 'chunks_fts', 'chunk_vectors']) {
      expect(tables).toContain(name)
    }
  })

  it('is a no-op when the database is already current', () => {
    const db = openDatabase(':memory:')
    expect(migrate(db)).toEqual([])
  })

  it('rejects a database from a newer app version', () => {
    const db = bareDb()
    db.pragma('user_version = 99')
    expect(() => migrate(db)).toThrow(/newer than this app supports/)
  })

  it('rejects out-of-order migration numbers', () => {
    const db = bareDb()
    expect(() => migrate(db, [{ version: 2, name: 'x', up: '' }])).toThrow(/numbered 1..n/)
  })

  it('rolls back a failing migration and leaves the version unchanged', () => {
    const db = bareDb()
    const broken = [...MIGRATIONS, { version: MIGRATIONS.length + 1, name: 'bad', up: 'CREATE TABLE t (a); NOT SQL' }]
    expect(() => migrate(db, broken)).toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 't'").get()).toBeUndefined()
  })
})

describe('SettingsStore', () => {
  it('sets, overwrites, reads and deletes values', () => {
    const store = new SettingsStore(openDatabase(':memory:'))
    expect(store.get('a')).toBeNull()
    store.set('a', '1')
    store.set('a', '2')
    expect(store.get('a')).toBe('2')
    store.delete('a')
    expect(store.get('a')).toBeNull()
  })
})

describe('ingestion schema', () => {
  it('puts a session id on every ingestion table', () => {
    const db = openDatabase(':memory:')
    for (const table of ['materials', 'pages', 'sections', 'chunks']) {
      const columns = db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((c) => c.name)
      expect(columns, table).toContain('session_id')
    }
    const vecSql = db.prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'chunk_vectors'").get()
    expect(vecSql?.sql).toMatch(/session_id INTEGER PARTITION KEY/)
  })

  it('identifies a material by session and content hash', () => {
    const db = openDatabase(':memory:')
    const session = new SessionStore(db).current()
    const insert = db.prepare(
      "INSERT INTO materials (session_id, sha256, original_name, stored_name, kind, byte_size) VALUES (?, 'abc', ?, 'abc.pdf', 'pdf', 1)"
    )
    insert.run(session.id, 'a.pdf')
    expect(() => insert.run(session.id, 'renamed.pdf')).toThrow(/UNIQUE/)
  })

  it('keeps keyword and vector indexes in step with chunks', () => {
    const db = openDatabase(':memory:')
    const session = new SessionStore(db).current()
    db.prepare("INSERT INTO materials (id, session_id, sha256, original_name, stored_name, kind, byte_size) VALUES (1, ?, 'h', 'f.pdf', 'h.pdf', 'pdf', 1)").run(session.id)
    db.prepare("INSERT INTO sections (id, session_id, material_id, ordinal, start_page, source) VALUES (1, ?, 1, 0, 1, 'whole')").run(session.id)
    db.prepare("INSERT INTO chunks (id, session_id, material_id, section_id, ordinal, page_start, page_end, text) VALUES (7, ?, 1, 1, 0, 1, 1, 'eigenvalues of a matrix')").run(session.id)
    db.prepare('INSERT INTO chunk_vectors (chunk_id, session_id, embedding) VALUES (?, ?, ?)').run(7n, BigInt(session.id), new Float32Array(384).fill(0.1))
    expect(db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'eigenvalue'").all()).toEqual([{ rowid: 7 }])

    db.prepare('DELETE FROM chunks WHERE id = 7').run()
    expect(db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'eigenvalue'").all()).toEqual([])
    expect(db.prepare('SELECT count(*) AS n FROM chunk_vectors').get()).toEqual({ n: 0 })
  })
})

describe('SessionStore', () => {
  it('creates one default session and returns it afterwards', () => {
    const store = new SessionStore(openDatabase(':memory:'))
    const first = store.current()
    expect(first.name).toBe('My course')
    expect(store.current()).toEqual(first)
    expect(store.get(first.id)).toEqual(first)
    expect(() => store.get(999)).toThrow(/does not exist/)
  })
})
