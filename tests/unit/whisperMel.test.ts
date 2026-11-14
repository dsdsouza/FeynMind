import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanTranscript, hasSpeech, splitIntoWindows } from '../../src/main/dictation/audio'
import { logMelSpectrogram, melFilters, N_FRAMES, N_MELS, SAMPLE_RATE, WINDOW_SAMPLES } from '../../src/main/dictation/mel'
import { readWav, wordErrorRate } from '../helpers/wav'

// whisper-mel-reference.json was produced independently with numpy and librosa, following OpenAI's
// reference recipe (see the "source" clip in tests/fixtures/audio).
interface Reference {
  source: string
  shape: [number, number]
  mean: number
  samples: [number, number, number][]
  filterSamples: [number, number, number][]
}
const reference = JSON.parse(readFileSync(join(import.meta.dirname, 'whisper-mel-reference.json'), 'utf8')) as Reference
const fixture = (name: string) => readWav(join(import.meta.dirname, '..', 'fixtures', 'audio', name))

describe('Whisper log-mel features', () => {
  it('builds the same Slaney mel filters as librosa', () => {
    const filters = melFilters()
    expect(filters.length).toBe(N_MELS)
    for (const [m, k, value] of reference.filterSamples) expect(filters[m]?.[k]).toBeCloseTo(value, 6)
  })

  it('matches the reference spectrogram of a fixture clip', () => {
    const { samples, sampleRate } = fixture(reference.source)
    expect(sampleRate).toBe(SAMPLE_RATE)
    const mel = logMelSpectrogram(samples)
    expect([N_MELS, N_FRAMES]).toEqual(reference.shape)
    for (const [m, t, value] of reference.samples) expect(mel[m * N_FRAMES + t]).toBeCloseTo(value, 4)
    const mean = mel.reduce((a, b) => a + b, 0) / mel.length
    expect(mean).toBeCloseTo(reference.mean, 4)
  })
})

describe('recording helpers', () => {
  it('treats near-silence as no speech', () => {
    expect(hasSpeech(new Float32Array(SAMPLE_RATE * 3))).toBe(false)
    const hiss = Float32Array.from({ length: SAMPLE_RATE * 3 }, (_, i) => 0.001 * Math.sin(i))
    expect(hasSpeech(hiss)).toBe(false)
    expect(hasSpeech(fixture('speech-9s.wav').samples)).toBe(true)
  })

  it('cuts long recordings at a quiet moment, at most 30 s apart, and drops silent pieces', () => {
    const speech = fixture('speech-29s.wav').samples
    const silence = new Float32Array(SAMPLE_RATE * 10)
    const long = new Float32Array(speech.length * 2 + silence.length)
    long.set(speech, 0)
    long.set(speech, speech.length)
    long.set(silence, speech.length * 2)
    const pieces = splitIntoWindows(long)
    expect(pieces.length).toBe(2)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(WINDOW_SAMPLES)
    expect(pieces.reduce((n, p) => n + p.length, 0)).toBeGreaterThanOrEqual(speech.length * 2 - WINDOW_SAMPLES)
    expect(splitIntoWindows(new Float32Array(SAMPLE_RATE * 40))).toEqual([])
  })

  it('removes non-speech markers and joins pieces with single spaces', () => {
    expect(cleanTranscript([' Hello there. [BLANK_AUDIO]', '(music) and  then ', '[ Silence ]'])).toBe('Hello there. and then')
    expect(cleanTranscript(['The domain is (-∞, 2) ∪ (2, ∞).'])).toBe('The domain is (-∞, 2) ∪ (2, ∞).')
  })

  it('computes word error rate', () => {
    expect(wordErrorRate('Mister Quilter is here', 'Mr. Quilter is here.')).toBe(0)
    expect(wordErrorRate('a b c d', 'a x c')).toBe(0.5)
  })
})
