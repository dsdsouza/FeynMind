import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWhisperTranscriber } from '../../src/main/dictation/whisper'
import { SPEECH_MODELS } from '../../src/main/dictation/models'
import { ensureModel } from '../../src/main/ingestion/modelStore'
import type { SpeechModelId } from '../../src/shared/dictation'
import { readWav, wordErrorRate } from '../helpers/wav'

// Opt-in (npm run test:models): downloads the pinned Whisper models once (about 375 MB for all
// three; FEYNMIND_SPEECH_MODELS=base.en limits it) and transcribes the LibriSpeech fixture clips,
// checking word error rate against their published transcripts and printing timings.
// No model API calls. The 29 s clip is hard on purpose: it is full of proper names.

const cacheDir = process.env['FEYNMIND_MODEL_CACHE'] ?? join(tmpdir(), 'feynmind-model-cache')
const audioDir = join(import.meta.dirname, '..', 'fixtures', 'audio')
const transcripts = JSON.parse(readFileSync(join(audioDir, 'transcripts.json'), 'utf8')) as Record<string, { transcript: string; seconds: number }>
const only = process.env['FEYNMIND_SPEECH_MODELS']?.split(',')
const models = (Object.keys(SPEECH_MODELS) as SpeechModelId[]).filter((id) => !only || only.includes(id))

/** Highest word error rate accepted per clip and model; the measured values are in docs/tech-plan.md. */
const MAX_WER: Record<SpeechModelId, Record<string, number>> = {
  'tiny.en': { 'speech-9s.wav': 0.15, 'speech-29s.wav': 0.35 },
  'base.en': { 'speech-9s.wav': 0.1, 'speech-29s.wav': 0.25 },
  'small.en': { 'speech-9s.wav': 0.1, 'speech-29s.wav': 0.2 }
}

describe.each(models)('Whisper %s', (id) => {
  it('transcribes the fixture clips', { timeout: 900_000 }, async () => {
    const folder = await ensureModel(cacheDir, SPEECH_MODELS[id], { fetch: (url, init) => fetch(url, init) })
    let started = performance.now()
    const transcriber = await createWhisperTranscriber(folder)
    const loadMs = performance.now() - started
    try {
      for (const [clip, expected] of Object.entries(transcripts)) {
        const { samples } = readWav(join(audioDir, clip))
        started = performance.now()
        const text = await transcriber.transcribe(samples)
        const ms = performance.now() - started
        const wer = wordErrorRate(expected.transcript, text)
        console.log(`${id} ${clip}: load ${Math.round(loadMs)} ms, transcribe ${Math.round(ms)} ms for ${expected.seconds} s, WER ${(wer * 100).toFixed(1)}%\n  ${text}`)
        expect(wer).toBeLessThanOrEqual(MAX_WER[id][clip] ?? 0)
      }
    } finally {
      await transcriber.close()
    }
  })
})
