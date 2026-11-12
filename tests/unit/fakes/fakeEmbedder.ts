import type { Embedder } from '../../../src/main/ingestion/embedder'

/**
 * A deterministic stand-in for the embedding model: a hashed bag of word stems, normalized.
 * Texts that share words get similar vectors, which is enough to test vector search plumbing
 * without downloading a model.
 */
export function createFakeEmbedder(): Embedder & { passagesEmbedded: number } {
  const dimensions = 384
  const embed = (text: string): Float32Array => {
    const vector = new Float32Array(dimensions)
    for (const word of text.toLowerCase().match(/\p{L}{3,}/gu) ?? []) {
      const stem = word.slice(0, 5)
      let hash = 2166136261
      for (const ch of stem) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619)
      vector[Math.abs(hash) % dimensions] = (vector[Math.abs(hash) % dimensions] ?? 0) + 1
    }
    const norm = Math.hypot(...vector) || 1
    return vector.map((x) => x / norm)
  }
  const fake = {
    modelId: 'fake',
    dimensions,
    passagesEmbedded: 0,
    async embedPassages(texts: string[]) {
      fake.passagesEmbedded += texts.length
      return texts.map(embed)
    },
    async embedQuery(text: string) {
      return embed(text)
    },
    async close() {}
  }
  return fake
}
