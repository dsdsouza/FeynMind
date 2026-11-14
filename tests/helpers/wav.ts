import { readFileSync } from 'node:fs'

/** Reads a 16-bit PCM mono WAV file into samples in [-1, 1]. Test fixtures only. */
export function readWav(path: string): { samples: Float32Array; sampleRate: number } {
  const buf = readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path} is not a WAV file`)
  let offset = 12
  let sampleRate = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      const format = buf.readUInt16LE(body)
      const channels = buf.readUInt16LE(body + 2)
      sampleRate = buf.readUInt32LE(body + 4)
      const bits = buf.readUInt16LE(body + 14)
      if (format !== 1 || channels !== 1 || bits !== 16) throw new Error(`${path} must be 16-bit PCM mono`)
    } else if (id === 'data') {
      const samples = new Float32Array(size / 2)
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(body + i * 2) / 32768
      return { samples, sampleRate }
    }
    offset = body + size + (size % 2)
  }
  throw new Error(`${path} has no data chunk`)
}

/** Lower-case words without punctuation, for comparing transcripts. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\bmr\b\.?/g, 'mister')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')
}

/** Word error rate: word-level edit distance divided by the reference's length. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = words(reference)
  const hyp = words(hypothesis)
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j)
  for (let i = 1; i <= ref.length; i++) {
    const row = [i]
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
    }
    prev = row
  }
  return (prev[hyp.length] ?? 0) / Math.max(1, ref.length)
}
