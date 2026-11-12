import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBgeEmbedder, type Embedder } from '../../src/main/ingestion/embedder'
import { BGE_SMALL_EN, ensureModel } from '../../src/main/ingestion/modelStore'

// Opt-in (npm run test:models): downloads the pinned embedding model (about 35 MB, once) and checks
// that our pipeline produces the right vectors. No model API calls.
//
// The reference vectors in bge-small-reference.json were produced independently: BAAI's own
// float32 weights, the Hugging Face Rust tokenizer and Python onnxruntime. We run the int8
// quantized export, so vectors match closely but not exactly.

interface Reference {
  examples: { text: string; ids: number[]; vector: number[] }[]
}

const reference = JSON.parse(readFileSync(join(import.meta.dirname, 'bge-small-reference.json'), 'utf8')) as Reference
const cacheDir = process.env['FEYNMIND_MODEL_CACHE'] ?? join(tmpdir(), 'feynmind-model-cache')
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

const cosine = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  return dot / Math.sqrt(na * nb)
}

let embedder: Embedder

beforeAll(async () => {
  const folder = await ensureModel(cacheDir, BGE_SMALL_EN, { fetch: (url, init) => fetch(url, init) })
  embedder = await createBgeEmbedder(folder, BGE_SMALL_EN.id)
}, 300_000)

afterAll(async () => {
  await embedder.close()
})

describe('bge-small-en-v1.5 embeddings', () => {
  it('produce unit-length 384-dimension vectors', async () => {
    const [vector] = await embedder.embedPassages(['A matrix times a vector.'])
    expect(vector?.length).toBe(384)
    expect(Math.hypot(...(vector ?? []))).toBeCloseTo(1, 5)
  })

  it('match the independent reference vectors', async () => {
    for (const example of reference.examples) {
      const vector = example.text.startsWith(QUERY_PREFIX)
        ? await embedder.embedQuery(example.text.slice(QUERY_PREFIX.length))
        : (await embedder.embedPassages([example.text]))[0]
      expect(vector, example.text).toBeDefined()
      const similarity = cosine(vector ?? [], example.vector)
      console.log(`cosine to reference ${similarity.toFixed(4)}: ${example.text}`)
      expect(similarity, example.text).toBeGreaterThan(0.98)
    }
  })

  it('score related passages clearly higher than unrelated ones', async () => {
    const query = await embedder.embedQuery('how do I find the eigenvalues of a matrix?')
    const [related, alsoRelated, unrelated] = await embedder.embedPassages([
      'To find the eigenvalues, solve det(A − λI) = 0 for λ.',
      'An eigenvector x of A satisfies Ax = λx; λ is its eigenvalue.',
      'The bakery sells fresh bread every morning.'
    ])
    const r1 = cosine(query, related ?? [])
    const r2 = cosine(query, alsoRelated ?? [])
    const u = cosine(query, unrelated ?? [])
    expect(r1 - u).toBeGreaterThan(0.25)
    expect(r2 - u).toBeGreaterThan(0.25)
  })

  // Dynamic int8 quantization computes its scales over the whole padded batch, so padding moves
  // vectors very slightly; far less than the gap between related and unrelated passages.
  it('gives nearly the same vector for a text alone or in a padded batch', async () => {
    const text = 'Gaussian elimination reduces a matrix to upper triangular form.'
    const [alone] = await embedder.embedPassages([text])
    const batch = await embedder.embedPassages(['short', text, 'a much longer sentence that forces padding in the batch for the others'])
    expect(cosine(alone ?? [], batch[1] ?? [])).toBeGreaterThan(0.995)
  })

  it('truncates text longer than the model accepts instead of failing', async () => {
    const [vector] = await embedder.embedPassages(['word '.repeat(2000)])
    expect(vector?.length).toBe(384)
  })
})
