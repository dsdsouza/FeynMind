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

  /** The session's caps on model use; null means no cap. */
  limits(id: number): { callCap: number | null; spendCapUsd: number | null } {
    const row = this.db
      .prepare<[number], { callCap: number | null; spendCapUsd: number | null }>('SELECT call_cap AS callCap, spend_cap_usd AS spendCapUsd FROM sessions WHERE id = ?')
      .get(id)
    if (!row) throw new Error(`Session ${id} does not exist.`)
    return row
  }

  setLimits(id: number, limits: { callCap: number | null; spendCapUsd: number | null }): void {
    this.db.prepare('UPDATE sessions SET call_cap = ?, spend_cap_usd = ? WHERE id = ?').run(limits.callCap, limits.spendCapUsd, id)
  }

  get(id: number): Session {
    const session = this.db
      .prepare<[number], Session>('SELECT id, name, created_at AS createdAt FROM sessions WHERE id = ?')
      .get(id)
    if (!session) throw new Error(`Session ${id} does not exist.`)
    return session
  }
}
