import { SAMPLE_RATE, WINDOW_SAMPLES } from './mel'

/** Longest recording accepted, in seconds. The interface stops recording here. */
export const MAX_RECORDING_SECONDS = 300

/**
 * Below this loudness (RMS of samples in [-1, 1], about -50 dBFS) a stretch of audio is treated as
 * silence and never sent to the model: Whisper tends to invent words ("Thank you.") for silence.
 */
export const SILENCE_RMS = 0.003

export function rms(audio: Float32Array, from = 0, to = audio.length): number {
  if (to <= from) return 0
  let sum = 0
  for (let i = from; i < to; i++) {
    const v = audio[i] ?? 0
    sum += v * v
  }
  return Math.sqrt(sum / (to - from))
}

/** The loudest 0.5 s of the recording, so a short phrase in a long quiet take still counts as speech. */
export function hasSpeech(audio: Float32Array): boolean {
  const step = SAMPLE_RATE / 2
  for (let from = 0; from < audio.length; from += step) {
    if (rms(audio, from, Math.min(audio.length, from + step)) >= SILENCE_RMS) return true
  }
  return false
}

const FRAME = SAMPLE_RATE / 10
/** A window is cut at the quietest tenth of a second in its last few seconds, so words are not split. */
const SEARCH_SECONDS = 5

/**
 * Splits a recording into pieces of at most 30 s for Whisper. Each cut is placed at the quietest
 * 0.1 s in the last 5 s of the window. Silent pieces are dropped.
 */
export function splitIntoWindows(audio: Float32Array): Float32Array[] {
  const pieces: Float32Array[] = []
  let start = 0
  while (audio.length - start > WINDOW_SAMPLES) {
    let cut = start + WINDOW_SAMPLES
    let quietest = Infinity
    for (let f = start + WINDOW_SAMPLES - SEARCH_SECONDS * SAMPLE_RATE; f + FRAME <= start + WINDOW_SAMPLES; f += FRAME) {
      const level = rms(audio, f, f + FRAME)
      if (level < quietest) {
        quietest = level
        cut = f + FRAME / 2
      }
    }
    pieces.push(audio.subarray(start, cut))
    start = cut
  }
  pieces.push(audio.subarray(start))
  return pieces.filter(hasSpeech)
}

/** Whisper marks non-speech in brackets: "[BLANK_AUDIO]", "(music)", "[ Silence ]". */
const NON_SPEECH = /\s*(\[[^\]]*\]|\((?:music|silence|applause|laughter|noise|inaudible|blank_audio)[^)]*\))\s*/gi

/** Joins the windows' text and tidies it: no non-speech markers, single spaces, trimmed. */
export function cleanTranscript(pieces: string[]): string {
  return pieces
    .map((p) => p.replace(NON_SPEECH, ' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}
