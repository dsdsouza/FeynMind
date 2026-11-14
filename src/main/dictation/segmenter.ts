import { rms, SILENCE_RMS } from './audio'
import { SAMPLE_RATE } from './mel'

// Cuts a live recording into segments at the speaker's pauses, so each segment can be transcribed
// while the learner is still talking and only the last one is left when they press stop.

const FRAME = SAMPLE_RATE / 10
/** A pause is at least this many quiet frames (0.6 s). */
const PAUSE_FRAMES = 6
/** Segments shorter than this are not cut: short audio is misheard more (measured: 4 s cost tiny up to 4 points of word error rate, 8 s at most 1.8; see docs/tech-plan.md). */
const MIN_SEGMENT_SECONDS = 8
/** Without a pause, a segment is cut at the quietest moment of its last 5 s at this length. */
const MAX_SEGMENT = 25 * SAMPLE_RATE
const SEARCH = 5 * SAMPLE_RATE
/** A frame is quiet below this share of the average loudness of the speech heard so far. */
const QUIET_SHARE = 0.15

export class Segmenter {
  private readonly minSegment: number
  constructor(minSeconds = MIN_SEGMENT_SECONDS) {
    this.minSegment = minSeconds * SAMPLE_RATE
  }

  private buffer = new Float32Array(MAX_SEGMENT + SAMPLE_RATE)
  private length = 0
  /** Frames of the current segment already examined. */
  private scanned = 0
  private quietRun = 0
  private speechLevelSum = 0
  private speechFrames = 0

  /** Adds audio; returns the segments completed by it, in order. */
  push(chunk: Float32Array): Float32Array[] {
    const done: Float32Array[] = []
    let offset = 0
    while (offset < chunk.length) {
      const take = Math.min(chunk.length - offset, this.buffer.length - this.length)
      this.buffer.set(chunk.subarray(offset, offset + take), this.length)
      this.length += take
      offset += take
      for (let cut = this.scan(); cut !== null; cut = this.scan()) done.push(this.cutAt(cut))
    }
    return done
  }

  /** The audio not yet returned as a segment (the last segment); resets the segmenter. */
  flush(): Float32Array {
    const rest = this.buffer.slice(0, this.length)
    this.length = 0
    this.scanned = 0
    this.quietRun = 0
    return rest
  }

  /** Examines new whole frames; returns where to cut, or null when no cut is due yet. */
  private scan(): number | null {
    while ((this.scanned + 1) * FRAME <= this.length) {
      const from = this.scanned * FRAME
      const level = rms(this.buffer, from, from + FRAME)
      this.scanned++
      const average = this.speechFrames > 0 ? this.speechLevelSum / this.speechFrames : 0
      const quiet = level < Math.max(SILENCE_RMS, average * QUIET_SHARE)
      if (quiet) {
        this.quietRun++
      } else {
        this.quietRun = 0
        this.speechLevelSum += level
        this.speechFrames++
      }
      const end = this.scanned * FRAME
      // Cut in the middle of the pause heard so far.
      if (this.quietRun >= PAUSE_FRAMES && end - (this.quietRun * FRAME) / 2 >= this.minSegment) return end - Math.floor((this.quietRun * FRAME) / 2)
      if (end >= MAX_SEGMENT) return this.quietestCut(end)
    }
    return null
  }

  private quietestCut(end: number): number {
    let cut = end
    let quietest = Infinity
    for (let f = end - SEARCH; f + FRAME <= end; f += FRAME) {
      const level = rms(this.buffer, f, f + FRAME)
      if (level < quietest) {
        quietest = level
        cut = f + FRAME / 2
      }
    }
    return cut
  }

  private cutAt(cut: number): Float32Array {
    const segment = this.buffer.slice(0, cut)
    this.buffer.copyWithin(0, cut, this.length)
    this.length -= cut
    this.scanned = 0
    this.quietRun = 0
    return segment
  }
}
