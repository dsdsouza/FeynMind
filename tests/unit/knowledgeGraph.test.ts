import { describe, expect, it } from 'vitest'
import { cycles, edgesBreakingCycles, learningOrder, wouldMakeCycle, type PrereqEdge } from '../../src/main/knowledge/graph'
import { comparePairs, cosine, groups, resolvePrereq, type MergeItem } from '../../src/main/knowledge/merge'

const e = (concept: number, prereq: number, source: 'extracted' | 'user' = 'extracted'): PrereqEdge => ({ concept, prereq, source })

describe('prerequisite graph', () => {
  it('finds loops, including long ones, and ignores acyclic parts', () => {
    expect(cycles([1, 2, 3, 4], [e(1, 2), e(2, 3), e(3, 1), e(4, 1)])).toEqual([[1, 2, 3]])
    expect(cycles([1, 2, 3], [e(1, 2), e(2, 3)])).toEqual([])
    const n = 5000
    const chain = Array.from({ length: n - 1 }, (_, i) => e(i + 1, i + 2))
    expect(cycles(Array.from({ length: n }, (_, i) => i + 1), [...chain, e(n, 1)])[0]).toHaveLength(n)
  })

  it('breaks a loop at the link pointing furthest forward in the book', () => {
    // Positions: 1 at page 10, 2 at page 20, 3 at page 30. "1 needs 3" points forward (3 comes later).
    const pos = (id: number): number => id * 10
    const removed = edgesBreakingCycles([e(3, 2), e(2, 1), e(1, 3)], pos)
    expect(removed).toEqual([e(1, 3)])
  })

  it('keeps the user’s own links when breaking a loop', () => {
    const pos = (id: number): number => id * 10
    const removed = edgesBreakingCycles([e(2, 1), e(1, 2, 'user')], pos)
    expect(removed).toEqual([e(2, 1)])
  })

  it('breaks loops that share a node until none remain', () => {
    const pos = (id: number): number => id
    const edges = [e(1, 2), e(2, 1), e(2, 3), e(3, 2), e(1, 3), e(3, 1)]
    const removed = edgesBreakingCycles(edges, pos)
    const left = edges.filter((x) => !removed.includes(x))
    expect(cycles([1, 2, 3], left)).toEqual([])
  })

  it('tells when a new link would make a loop', () => {
    const edges = [e(3, 2), e(2, 1)]
    expect(wouldMakeCycle(edges, 1, 3)).toBe(true)
    expect(wouldMakeCycle(edges, 3, 1)).toBe(false)
    expect(wouldMakeCycle(edges, 2, 2)).toBe(true)
  })

  it('orders concepts after their prerequisites, otherwise by book position', () => {
    const pos = (id: number): number => ({ 1: 30, 2: 10, 3: 20, 4: 5 })[id] ?? 0
    // 2 needs 1, even though 1 appears later in the book. 4 is independent and earliest.
    expect(learningOrder([1, 2, 3, 4], [e(2, 1)], pos)).toEqual([4, 3, 1, 2])
    // Links to concepts outside the unit are ignored.
    expect(learningOrder([2, 3], [e(2, 1)], pos)).toEqual([2, 3])
  })

  it('refuses to order a graph with a loop', () => {
    expect(() => learningOrder([1, 2], [e(1, 2), e(2, 1)], (id) => id)).toThrow(/loop/)
  })
})

const v = (...xs: number[]): Float32Array => Float32Array.from(xs)
const item = (key: string, name: string, vector: Float32Array, sectionId: number | null = null): MergeItem => ({ key, name, sectionId, vector })

describe('merging', () => {
  const band = { same: 0.95, unclear: 0.8 }

  it('merges the same name written differently, and clearly similar vectors, without the model', () => {
    const { same, unclear } = comparePairs(
      [item('m1', 'Inverse Matrices', v(1, 0), 1), item('m2', 'the inverse matrix', v(0, 1), 2), item('m3', 'dot product', v(1, 0.01), 3)],
      [],
      band
    )
    expect(same).toContainEqual(['m1', 'm2'])
    expect(same).toContainEqual(['m1', 'm3'])
    expect(unclear).toEqual([])
  })

  it('sends only the unclear band to the model, and never pairs mentions of one section', () => {
    const { same, unclear } = comparePairs([item('m1', 'a', v(1, 0), 1), item('m2', 'b', v(0.85, 0.53), 2), item('m3', 'c', v(1, 0.01), 1)], [], band)
    // m1 and m3 are in the same section; m2 is about 0.85 similar to both.
    expect(same).toEqual([])
    expect(unclear.map((p) => `${p.a}-${p.b}`).sort()).toEqual(['m1-m2', 'm2-m3'])
  })

  it('compares new items with existing concepts but not existing ones with each other', () => {
    const { same } = comparePairs([item('m1', 'rank', v(1, 0), 1)], [item('c1', 'rank', v(1, 0)), item('c2', 'rank', v(1, 0))], band)
    expect(same).toEqual([['m1', 'c1'], ['m1', 'c2']])
  })

  it('groups linked keys', () => {
    expect(groups(['a', 'b', 'c', 'd'], [['a', 'c'], ['c', 'd']])).toEqual([['a', 'c', 'd'], ['b']])
  })

  it('computes cosine similarity', () => {
    expect(cosine(v(1, 0), v(1, 0))).toBeCloseTo(1)
    expect(cosine(v(1, 0), v(0, 1))).toBeCloseTo(0)
  })

  it('resolves prerequisite names by name, by clear similarity, or asks', () => {
    const concepts = [
      { key: 'n0', names: ['matrix multiplication'], nameVector: v(1, 0) },
      { key: 'n1', names: ['determinant'], nameVector: v(0, 1) }
    ]
    expect(resolvePrereq('Matrix Multiplication', v(0, 0), concepts, band).match).toBe('n0')
    expect(resolvePrereq('product of matrices', v(0.99, 0.05), concepts, band).match).toBe('n0')
    const unsure = resolvePrereq('matrix product', v(0.9, 0.44), concepts, band)
    expect(unsure.match).toBeNull()
    expect(unsure.unclear.map((c) => c.key)).toEqual(['n0'])
    expect(resolvePrereq('limits', v(-1, 0), concepts, band)).toEqual({ match: null, unclear: [] })
  })
})
