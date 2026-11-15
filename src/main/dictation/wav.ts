import { readFileSync } from 'node:fs'

/**
 * Reads a 16-bit PCM mono WAV file into samples in [-1, 1]. Used for the clip of the speed check
 * (a file shipped with the app) and by tests; recordings never become files.
 */
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
