import type Database from 'better-sqlite3'

/** A small key/value store backed by the settings table. */
export class SettingsStore {
  private readonly getStmt: Database.Statement<[string], { value: string }>
  private readonly setStmt: Database.Statement<[string, string]>
  private readonly deleteStmt: Database.Statement<[string]>

  constructor(db: Database.Database) {
    this.getStmt = db.prepare('SELECT value FROM settings WHERE key = ?')
    this.setStmt = db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    )
    this.deleteStmt = db.prepare('DELETE FROM settings WHERE key = ?')
  }

  get(key: string): string | null {
    return this.getStmt.get(key)?.value ?? null
  }

  set(key: string, value: string): void {
    this.setStmt.run(key, value)
  }

  delete(key: string): void {
    this.deleteStmt.run(key)
  }
}
