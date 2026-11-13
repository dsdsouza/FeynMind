import { normalizeName } from './schemas'

// Deciding which extracted concepts are the same. Local embeddings decide the clear cases; only
// pairs in an unclear band of similarity go to the model.

/**
 * Similarity bands for bge-small-en-v1.5 (cosine), measured on the pairs in
 * tests/models/concept-pairs.json (tests/models/thresholds.models.test.ts, 2026-11-13).
 * Duplicate concepts scored 0.76-0.87 and related but distinct ones up to 0.84, so vectors alone
 * cannot tell them apart in that range: only pairs above every distinct pair seen merge on their
 * own, and the wide band below goes to the model. Prerequisite names: duplicates 0.70-0.99,
 * distinct names up to 0.88.
 */
export const THRESHOLDS = {
  /** "name: definition" of two concepts. */
  concept: { same: 0.9, unclear: 0.75 },
  /** A prerequisite's name against a concept's name. */
  prereq: { same: 0.92, unclear: 0.69 }
} as const

/** At most this many unclear candidates per concept or prerequisite name are checked with the model. */
export const MAX_UNCLEAR_PER_ITEM = 3

export interface MergeItem {
  /** Unique across mentions and existing concepts, e.g. "m12" or "c5". */
  key: string
  name: string
  /** Mentions from the same section were already told apart by the model, so they are never merged with each other. */
  sectionId: number | null
  vector: Float32Array
}

export interface UnclearPair {
  a: string
  b: string
  similarity: number
}

export function cosine(a: Float32Array, b: Float32Array): number {
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
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

/**
 * Sorts pairs into sure matches and unclear ones. `fresh` items are compared with each other and
 * with `existing` ones; existing items are never compared with each other (already decided).
 */
export function comparePairs(fresh: MergeItem[], existing: MergeItem[], band: { same: number; unclear: number } = THRESHOLDS.concept): { same: [string, string][]; unclear: UnclearPair[] } {
  const same: [string, string][] = []
  const candidates: UnclearPair[] = []
  const consider = (a: MergeItem, b: MergeItem): void => {
    if (a.sectionId !== null && a.sectionId === b.sectionId) return
    if (normalizeName(a.name) === normalizeName(b.name)) {
      same.push([a.key, b.key])
      return
    }
    const similarity = cosine(a.vector, b.vector)
    if (similarity >= band.same) same.push([a.key, b.key])
    else if (similarity >= band.unclear) candidates.push({ a: a.key, b: b.key, similarity })
  }
  fresh.forEach((a, i) => {
    for (const b of fresh.slice(i + 1)) consider(a, b)
    for (const b of existing) consider(a, b)
  })
  return { same, unclear: limitPerItem(candidates) }
}

/** Keeps each item's few most similar unclear candidates, so model calls stay bounded. */
function limitPerItem(pairs: UnclearPair[]): UnclearPair[] {
  const count = new Map<string, number>()
  const kept: UnclearPair[] = []
  for (const pair of [...pairs].sort((x, y) => y.similarity - x.similarity)) {
    if ((count.get(pair.a) ?? 0) >= MAX_UNCLEAR_PER_ITEM || (count.get(pair.b) ?? 0) >= MAX_UNCLEAR_PER_ITEM) continue
    count.set(pair.a, (count.get(pair.a) ?? 0) + 1)
    count.set(pair.b, (count.get(pair.b) ?? 0) + 1)
    kept.push(pair)
  }
  return kept
}

/** Groups keys joined by `links` (union-find). Every key appears in exactly one group, in first-seen order. */
export function groups(keys: string[], links: [string, string][]): string[][] {
  const parent = new Map(keys.map((k) => [k, k]))
  const find = (k: string): string => {
    let root = k
    while (parent.get(root) !== root) root = parent.get(root) ?? root
    let node = k
    while (parent.get(node) !== root) {
      const up = parent.get(node) ?? root
      parent.set(node, root)
      node = up
    }
    return root
  }
  for (const [a, b] of links) {
    if (!parent.has(a) || !parent.has(b)) continue
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }
  const result = new Map<string, string[]>()
  for (const k of keys) {
    const root = find(k)
    result.set(root, [...(result.get(root) ?? []), k])
  }
  return [...result.values()]
}

export interface PrereqCandidate {
  /** Concept key the name most likely refers to. */
  key: string
  similarity: number
}

/**
 * Resolves a prerequisite name to a concept: by the same name, by clearly similar wording, or
 * not at all. Returns the unclear candidates when it cannot decide alone.
 */
export function resolvePrereq(
  name: string,
  nameVector: Float32Array,
  concepts: { key: string; names: string[]; nameVector: Float32Array }[],
  band: { same: number; unclear: number } = THRESHOLDS.prereq
): { match: string | null; unclear: PrereqCandidate[] } {
  const normalized = normalizeName(name)
  const exact = concepts.find((c) => c.names.some((n) => normalizeName(n) === normalized))
  if (exact) return { match: exact.key, unclear: [] }
  const scored = concepts.map((c) => ({ key: c.key, similarity: cosine(nameVector, c.nameVector) })).sort((a, b) => b.similarity - a.similarity)
  const best = scored[0]
  if (best && best.similarity >= band.same && (scored[1]?.similarity ?? 0) < band.same) return { match: best.key, unclear: [] }
  return { match: null, unclear: scored.filter((s) => s.similarity >= band.unclear).slice(0, 2) }
}
