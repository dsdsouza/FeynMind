import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseReteach, parseReviewQuestions, verdictOf, type Criterion } from '../../src/main/tutor/schemas'

// Real replies recorded by tests/live/retention.live.test.ts (batches R1 to R3) must keep passing
// the app's checks. Loosen a check only for harmless variations.

const RECORDED = join(import.meta.dirname, '..', 'fixtures', 'recorded')
const R1 = join(RECORDED, 'R1-review-questions.json')
const R2 = join(RECORDED, 'R2-reteach.json')
const R3 = join(RECORDED, 'R3-review-grading.json')

interface Call {
  keys: string[]
  reply: string
  allowed: string[]
}

describe.runIf(existsSync(R1))('recorded review questions', () => {
  const recorded = JSON.parse(readFileSync(R1, 'utf8')) as { calls: Call[]; concepts: Record<string, { asked: string[] }> }
  const asked = Object.values(recorded.concepts).map((c) => c.asked)

  it('every reply passes validation: three questions, each with a rubric, a hint and allowed pages, none repeating an asked one', () => {
    expect(recorded.calls).toHaveLength(3)
    recorded.calls.forEach((call, i) => {
      const parsed = parseReviewQuestions(call.reply, new Set(call.allowed), asked[i] ?? [])
      expect(parsed.covered).toBe(true)
      expect(parsed.questions).toHaveLength(3)
      for (const q of parsed.questions) {
        expect(q.hint.length).toBeGreaterThan(10)
        expect(q.pages.length).toBeGreaterThan(0)
        expect(q.criteria.every((c, j) => c.id === `c${j + 1}`)).toBe(true)
        expect(q.criteria.some((c) => c.essential)).toBe(true)
      }
    })
  })
})

describe.runIf(existsSync(R2))('recorded re-teaches', () => {
  const recorded = JSON.parse(readFileSync(R2, 'utf8')) as { calls: Call[] }

  it('every reply is short, cites only pages that were sent, and claims the materials cover it', () => {
    expect(recorded.calls).toHaveLength(3)
    for (const call of recorded.calls) {
      const parsed = parseReteach(call.reply, new Set(call.allowed))
      expect(parsed.outsideSources).toBe(false)
      expect(parsed.markdown.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(220)
    }
  })
})

describe.runIf(existsSync(R3) && existsSync(R1))('recorded grades of review answers', () => {
  const grading = JSON.parse(readFileSync(R3, 'utf8')) as { cases: { id: string; expected: string; verdict: string; grade: { criteria: { id: string; met: 'yes' | 'partly' | 'no'; evidence: string }[] } }[] }
  const r1 = JSON.parse(readFileSync(R1, 'utf8')) as { concepts: Record<string, { questions: { criteria: Criterion[] }[] }> }
  const cases = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'bench', 'review-grading-cases.json'), 'utf8')) as { id: string; concept: string; question: number }[]

  it('the unchanged grade prompt agreed with every expected verdict, recomputed from the recorded criteria', () => {
    for (const g of grading.cases) {
      const c = cases.find((x) => x.id === g.id)
      const rubric = r1.concepts[c?.concept ?? '']?.questions[c?.question ?? -1]?.criteria ?? []
      expect([g.id, verdictOf(rubric, g.grade.criteria).verdict]).toEqual([g.id, g.expected])
    }
  })
})
