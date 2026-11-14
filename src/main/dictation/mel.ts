// Whisper's input features: an 80-band log-mel spectrogram of 30 seconds of 16 kHz audio, computed
// the way OpenAI's reference implementation does (a 400-sample periodic Hann window every 160
// samples, centred with reflect padding, power spectrum, Slaney mel filters, log10, a floor 8 below
// the maximum, then (x + 4) / 4). Written for this project; tests/unit/whisperMel.test.ts checks it
// against values produced independently with numpy and librosa.

export const SAMPLE_RATE = 16_000
export const N_FFT = 400
export const HOP = 160
export const N_MELS = 80
/** Whisper always looks at 30 s windows. */
export const WINDOW_SAMPLES = 30 * SAMPLE_RATE
export const N_FRAMES = WINDOW_SAMPLES / HOP
const N_BINS = N_FFT / 2 + 1

// Slaney's mel scale (librosa's default): linear below 1 kHz, logarithmic above.
const F_SP = 200 / 3
const MIN_LOG_HZ = 1000
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP
const LOG_STEP = Math.log(6.4) / 27

function hzToMel(hz: number): number {
  return hz >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP : hz / F_SP
}

function melToHz(mel: number): number {
  return mel >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL)) : F_SP * mel
}

/** The mel filter bank, [N_MELS][N_BINS], with Slaney area normalisation (librosa.filters.mel). */
export function melFilters(): Float64Array[] {
  const fftFreqs = Array.from({ length: N_BINS }, (_, k) => (k * SAMPLE_RATE) / N_FFT)
  const maxMel = hzToMel(SAMPLE_RATE / 2)
  const melF = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz((i * maxMel) / (N_MELS + 1)))
  const filters: Float64Array[] = []
  for (let m = 0; m < N_MELS; m++) {
    const row = new Float64Array(N_BINS)
    const [lo, mid, hi] = [melF[m] ?? 0, melF[m + 1] ?? 0, melF[m + 2] ?? 0]
    const norm = 2 / (hi - lo)
    for (let k = 0; k < N_BINS; k++) {
      const f = fftFreqs[k] ?? 0
      const lower = (f - lo) / (mid - lo)
      const upper = (hi - f) / (hi - mid)
      row[k] = Math.max(0, Math.min(lower, upper)) * norm
    }
    filters.push(row)
  }
  return filters
}

const FILTERS = melFilters()
/** Each filter's non-zero bins, so the filter product skips the zeros. */
const FILTER_SPANS = FILTERS.map((row) => {
  let first = row.findIndex((w) => w > 0)
  if (first < 0) first = 0
  let last = N_BINS - 1
  while (last > first && (row[last] ?? 0) === 0) last--
  return [first, last] as const
})
const HANN = Float64Array.from({ length: N_FFT }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT))
// A plain DFT with precomputed tables: 400 is not a power of two, and frames of silence (the padding
// after a short recording) are skipped, so this is fast enough (well under a second per window).
const COS = new Float64Array(N_BINS * N_FFT)
const SIN = new Float64Array(N_BINS * N_FFT)
for (let k = 0; k < N_BINS; k++) {
  for (let n = 0; n < N_FFT; n++) {
    const angle = (2 * Math.PI * ((k * n) % N_FFT)) / N_FFT
    COS[k * N_FFT + n] = Math.cos(angle)
    SIN[k * N_FFT + n] = Math.sin(angle)
  }
}

/**
 * Log-mel features of up to 30 s of 16 kHz mono audio (longer input is cut, shorter is padded with
 * silence), laid out [N_MELS][N_FRAMES] as Whisper's encoder expects.
 */
export function logMelSpectrogram(audio: Float32Array): Float32Array {
  const samples = new Float64Array(WINDOW_SAMPLES)
  samples.set(audio.subarray(0, WINDOW_SAMPLES))
  // Centre the frames: reflect 200 samples at each end.
  const pad = N_FFT / 2
  const padded = new Float64Array(WINDOW_SAMPLES + 2 * pad)
  padded.set(samples, pad)
  for (let i = 1; i <= pad; i++) {
    padded[pad - i] = samples[i] ?? 0
    padded[pad + WINDOW_SAMPLES - 1 + i] = samples[WINDOW_SAMPLES - 1 - i] ?? 0
  }

  const mel = new Float64Array(N_MELS * N_FRAMES)
  const frame = new Float64Array(N_FFT)
  const power = new Float64Array(N_BINS)
  for (let t = 0; t < N_FRAMES; t++) {
    const start = t * HOP
    let silent = true
    for (let n = 0; n < N_FFT; n++) {
      const v = (padded[start + n] ?? 0) * (HANN[n] ?? 0)
      frame[n] = v
      if (v !== 0) silent = false
    }
    if (silent) continue
    for (let k = 0; k < N_BINS; k++) {
      let re = 0
      let im = 0
      const base = k * N_FFT
      for (let n = 0; n < N_FFT; n++) {
        const v = frame[n] ?? 0
        re += v * (COS[base + n] ?? 0)
        im -= v * (SIN[base + n] ?? 0)
      }
      power[k] = re * re + im * im
    }
    for (let m = 0; m < N_MELS; m++) {
      const row = FILTERS[m] as Float64Array
      const [first, last] = FILTER_SPANS[m] as readonly [number, number]
      let sum = 0
      for (let k = first; k <= last; k++) sum += (row[k] ?? 0) * (power[k] ?? 0)
      mel[m * N_FRAMES + t] = sum
    }
  }

  let max = -Infinity
  for (let i = 0; i < mel.length; i++) {
    const v = Math.log10(Math.max(mel[i] ?? 0, 1e-10))
    mel[i] = v
    if (v > max) max = v
  }
  const out = new Float32Array(mel.length)
  for (let i = 0; i < mel.length; i++) out[i] = (Math.max(mel[i] ?? 0, max - 8) + 4) / 4
  return out
}
