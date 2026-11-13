import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A small log of unexpected exits, kept in the app's data folder so a crash can be looked into
// later. It never leaves the machine. It holds exit codes, reasons and error stacks, never keys
// (the caller redacts them) and never course content.

/** When the log grows past this size it is moved to exits.old.log and a new one started. */
const MAX_BYTES = 1_000_000

export class ExitLog {
  readonly path: string
  private readonly oldPath: string
  /** Present while the app runs; left behind if it ends without a clean quit. */
  private readonly markerPath: string

  constructor(
    dir: string,
    private readonly now: () => Date = () => new Date()
  ) {
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, 'exits.log')
    this.oldPath = join(dir, 'exits.old.log')
    this.markerPath = join(dir, 'running')
  }

  /** Appends one line with a timestamp. Never throws: logging must not turn into a second failure. */
  record(message: string): void {
    try {
      if (existsSync(this.path) && statSync(this.path).size > MAX_BYTES) renameSync(this.path, this.oldPath)
      appendFileSync(this.path, `${this.now().toISOString()} ${message.replace(/\r?\n/g, '\n    ')}\n`)
    } catch (error) {
      console.error('Could not write to the exit log:', error)
    }
  }

  /**
   * Call at startup. If the last run never reached a clean quit (it was force-closed, crashed, or
   * the computer lost power), records that and returns true. Then marks this run as running.
   */
  startRun(pid: number): boolean {
    let unclean = false
    try {
      if (existsSync(this.markerPath)) {
        unclean = true
        const previous = readFileSync(this.markerPath, 'utf8').trim()
        this.record(
          `FeynMind did not shut down cleanly last time (${previous || 'no details'}). Exit code and reason unknown: ` +
            'it was force-closed or crashed before it could record them, or the computer shut down.'
        )
      }
      writeFileSync(this.markerPath, `process ${pid}, started ${this.now().toISOString()}`)
    } catch (error) {
      console.error('Could not update the exit log:', error)
    }
    return unclean
  }

  /** Call when the app quits normally. */
  endRun(): void {
    try {
      rmSync(this.markerPath, { force: true })
    } catch (error) {
      console.error('Could not update the exit log:', error)
    }
  }
}
