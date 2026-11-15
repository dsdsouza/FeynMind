export { readWav } from '../../src/main/dictation/wav'

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
