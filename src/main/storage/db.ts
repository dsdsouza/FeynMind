import Database from 'better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { migrate } from './migrations'

/**
 * Loads the sqlite-vec extension into a connection. Migrations need it (they create a vec0 table),
 * so every connection to the app database loads it before use.
 */
export function loadVectorExtension(db: Database.Database): void {
  // In a packaged app the extension is unpacked next to app.asar (see electron-builder.yml),
  // because SQLite cannot load a library from inside an archive.
  db.loadExtension(getLoadablePath().replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'))
}

/**
 * Opens (or creates) the database at `path` and brings its schema up to date. Use ':memory:' in tests.
 * Both the main process and the ingestion worker open their own connection; WAL mode lets them
 * read and write at the same time, and the busy timeout makes one wait briefly for the other.
 */
export function openDatabase(path: string, options: { migrate?: boolean } = {}): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  loadVectorExtension(db)
  if (options.migrate ?? true) migrate(db)
  return db
}
