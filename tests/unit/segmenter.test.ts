import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SAMPLE_RATE } from '../../src/main/dictation/mel'
import { Segmenter } from '../../src/main/dictation/segmenter'
import { readWav } from '../helpers/wav'

const tone = (seconds: number, level = 0.2) => Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, i) => level * Math.sin(i / 7))
const silence = (seconds: number) => new Float32Array(seconds * SAMPLE_RATE)
const join_ = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
/** Feeds audio in 0.25 s chunks, as the recorder sends it, and collects the segments. */
function feed(segmenter: Segmenter, audio: Float32Array): Float32Array[] {
  const out: Float32Array[] = []
  for (let i = 0; i < audio.length; i += SAMPLE_RATE / 4) out.push(...segmenter.push(audio.subarray(i, i + SAMPLE_RATE / 4)))
  return out
}
const seconds = (a: Float32Array) => a.length / SAMPLE_RATE

describe('segmenter', () => {
  it('cuts in the middle of a pause once a segment is long enough, and keeps every sample', () => {
    const audio = join_(tone(9), silence(1), tone(3), silence(1), tone(6))
    const s = new Segmenter(8)
    const segments = feed(s, audio)
    // The pause after 3 s of speech is too early (under 8 s); the one at 9 s is used.
    expect(segments).toHaveLength(1)
    expect(seconds(segments[0] as Float32Array)).toBeGreaterThan(9.2)
    expect(seconds(segments[0] as Float32Array)).toBeLessThan(9.8)
    const rest = s.flush()
    expect(seconds(rest) + seconds(segments[0] as Float32Array)).toBeCloseTo(seconds(audio), 5)
  })

  it('ignores a pause shorter than 0.6 s', () => {
    const s = new Segmenter(8)
    expect(feed(s, join_(tone(9), silence(0.4), tone(3)))).toEqual([])
    expect(seconds(s.flush())).toBeCloseTo(12.4, 5)
  })

  it('cuts at the quietest moment by 25 s when the speaker never pauses', () => {
    const quietDip = join_(tone(22), tone(0.3, 0.01), tone(10))
    const segments = feed(new Segmenter(8), quietDip)
    expect(segments).toHaveLength(1)
    expect(seconds(segments[0] as Float32Array)).toBeGreaterThan(22)
    expect(seconds(segments[0] as Float32Array)).toBeLessThan(22.3)
  })

  it('treats quiet relative to the speaker: background noise counts as a pause', () => {
    const noise = Float32Array.from({ length: SAMPLE_RATE }, (_, i) => 0.01 * Math.sin(i))
    const segments = feed(new Segmenter(8), join_(tone(9), noise, tone(3)))
    expect(segments).toHaveLength(1)
  })

  it('splits real speech at its pauses into pieces of 8 to 25 s', () => {
    const speech = readWav(join(import.meta.dirname, '..', 'fixtures', 'audio', 'speech-29s.wav')).samples
    const s = new Segmenter(8)
    const segments = [...feed(s, speech), s.flush()]
    expect(segments.length).toBeGreaterThan(1)
    for (const seg of segments.slice(0, -1)) {
      expect(seconds(seg)).toBeGreaterThanOrEqual(8)
      expect(seconds(seg)).toBeLessThanOrEqual(25)
    }
    expect(segments.reduce((n, p) => n + p.length, 0)).toBe(speech.length)
  })
})
