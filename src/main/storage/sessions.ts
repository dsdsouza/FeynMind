import type Database from 'better-sqlite3'
import type { Session } from '../../shared/ingestion'

const DEFAULT_SESSION_NAME = 'My course'

/**
 * Course sessions. Milestone 2 uses a single default session; creating, renaming and switching
 * sessions come with milestone 9. Every ingestion table already carries a session id.
 */
export class SessionStore {
  constructor(private readonly db: Database.Database) {}

  /** Returns the first session, creating the default one on first use. */
  current(): Session {
    const existing = this.db
      .prepare<[], Session>('SELECT id, name, created_at AS createdAt FROM sessions ORDER BY id LIMIT 1')
      .get()
    if (existing) return existing
    const id = Number(this.db.prepare('INSERT INTO sessions (name) VALUES (?)').run(DEFAULT_SESSION_NAME).lastInsertRowid)
    return this.get(id)
  }

  get(id: number): Session {
    const session = this.db
      .prepare<[number], Session>('SELECT id, name, created_at AS createdAt FROM sessions WHERE id = ?')
      .get(id)
    if (!session) throw new Error(`Session ${id} does not exist.`)
    return session
  }
}
