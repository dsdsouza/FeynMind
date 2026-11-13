import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBgeEmbedder, type Embedder } from '../../src/main/ingestion/embedder'
import { BGE_SMALL_EN, ensureModel } from '../../src/main/ingestion/modelStore'
import { cosine, THRESHOLDS } from '../../src/main/knowledge/merge'

// Opt-in (npm run test:models): measures how the local embedding model scores pairs of concepts
// written for this project, and checks the merge bands in merge.ts against them. No model API calls.
// The printed table is how the bands were chosen.

type Concept = [string, string]
interface Pairs {
  concept: { same: [Concept, Concept][]; different: [Concept, Concept][] }
  prereq: { same: [string, string][]; different: [string, string][] }
}

const pairs = JSON.parse(readFileSync(join(import.meta.dirname, 'concept-pairs.json'), 'utf8')) as Pairs
const cacheDir = process.env['FEYNMIND_MODEL_CACHE'] ?? join(tmpdir(), 'feynmind-model-cache')
let embedder: Embedder

beforeAll(async () => {
  const folder = await ensureModel(cacheDir, BGE_SMALL_EN, { fetch: (url, init) => fetch(url, init) })
  embedder = await createBgeEmbedder(folder, BGE_SMALL_EN.id)
})

afterAll(async () => {
  await embedder?.close()
})

async function similarities(list: [string, string][]): Promise<number[]> {
  const vectors = await embedder.embedPassages(list.flat())
  return list.map((_, i) => cosine(vectors[2 * i] as Float32Array, vectors[2 * i + 1] as Float32Array))
}

const text = ([name, definition]: Concept): string => `${name}: ${definition}`

describe('merge similarity bands', () => {
  it('never merges distinct concepts on its own, and sends most duplicates to be checked', async () => {
    const same = await similarities(pairs.concept.same.map(([a, b]) => [text(a), text(b)]))
    const different = await similarities(pairs.concept.different.map(([a, b]) => [text(a), text(b)]))
    console.table([
      ...pairs.concept.same.map(([a, b], i) => ({ kind: 'same', a: a[0], b: b[0], similarity: same[i]?.toFixed(3) })),
      ...pairs.concept.different.map(([a, b], i) => ({ kind: 'different', a: a[0], b: b[0], similarity: different[i]?.toFixed(3) }))
    ])
    const band = THRESHOLDS.concept
    expect(Math.max(...different)).toBeLessThan(band.same)
    // Duplicates below the unclear band are missed and left for the user to merge; keep that rare.
    expect(same.filter((s) => s < band.unclear).length).toBeLessThanOrEqual(1)
  })

  it('resolves prerequisite names without confusing related ones', async () => {
    const same = await similarities(pairs.prereq.same)
    const different = await similarities(pairs.prereq.different)
    console.table([
      ...pairs.prereq.same.map(([a, b], i) => ({ kind: 'same', a, b, similarity: same[i]?.toFixed(3) })),
      ...pairs.prereq.different.map(([a, b], i) => ({ kind: 'different', a, b, similarity: different[i]?.toFixed(3) }))
    ])
    const band = THRESHOLDS.prereq
    expect(Math.max(...different)).toBeLessThan(band.same)
    expect(same.filter((s) => s < band.unclear).length).toBeLessThanOrEqual(1)
  })
})
