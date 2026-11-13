import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExitLog } from '../../src/main/exitLog'

let dir: string
const at = (): Date => new Date('2026-11-13T10:00:00.000Z')

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'feynmind-exitlog-')), 'logs')
})

afterEach(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true })
})

describe('exit log', () => {
  it('appends timestamped lines, indenting continuation lines', () => {
    const log = new ExitLog(dir, at)
    log.record('Ingestion worker exited unexpectedly with code 1.')
    log.record('Main process uncaughtException: boom\n    at f (index.js:1:1)')
    expect(readFileSync(log.path, 'utf8')).toBe(
      '2026-11-13T10:00:00.000Z Ingestion worker exited unexpectedly with code 1.\n' +
        '2026-11-13T10:00:00.000Z Main process uncaughtException: boom\n        at f (index.js:1:1)\n'
    )
  })

  it('records nothing for a run that quit cleanly', () => {
    const first = new ExitLog(dir, at)
    expect(first.startRun(100)).toBe(false)
    first.endRun()
    expect(new ExitLog(dir, at).startRun(200)).toBe(false)
    expect(existsSync(first.path)).toBe(false)
  })

  it('records a previous run that never quit cleanly', () => {
    new ExitLog(dir, at).startRun(100)
    // The app was killed: no endRun. The next start notices.
    const next = new ExitLog(dir, at)
    expect(next.startRun(200)).toBe(true)
    const text = readFileSync(next.path, 'utf8')
    expect(text).toContain('did not shut down cleanly last time (process 100, started 2026-11-13T10:00:00.000Z)')
    // This run is now the one being watched.
    next.endRun()
    expect(new ExitLog(dir, at).startRun(300)).toBe(false)
  })

  it('starts a new file once the log passes 1 MB', () => {
    const log = new ExitLog(dir, at)
    writeFileSync(log.path, 'x'.repeat(1_000_001))
    log.record('after rotation')
    expect(readFileSync(log.path, 'utf8')).toBe('2026-11-13T10:00:00.000Z after rotation\n')
    expect(readFileSync(join(dir, 'exits.old.log'), 'utf8')).toHaveLength(1_000_001)
  })
})
