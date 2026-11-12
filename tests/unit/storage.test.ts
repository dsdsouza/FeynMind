import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate, MIGRATIONS, openDatabase, SettingsStore } from '../../src/main/storage'

describe('migrations', () => {
  it('applies every migration to a new database and records the version', () => {
    const db = new Database(':memory:')
    expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.version))
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    expect(tables).toEqual([{ name: 'settings' }])
  })

  it('is a no-op when the database is already current', () => {
    const db = openDatabase(':memory:')
    expect(migrate(db)).toEqual([])
  })

  it('rejects a database from a newer app version', () => {
    const db = new Database(':memory:')
    db.pragma('user_version = 99')
    expect(() => migrate(db)).toThrow(/newer than this app supports/)
  })

  it('rejects out-of-order migration numbers', () => {
    const db = new Database(':memory:')
    expect(() => migrate(db, [{ version: 2, name: 'x', up: '' }])).toThrow(/numbered 1..n/)
  })

  it('rolls back a failing migration and leaves the version unchanged', () => {
    const db = new Database(':memory:')
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
