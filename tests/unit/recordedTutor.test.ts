import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDiagnostic, parseExplanation, parseLessonQuestions } from '../../src/main/tutor/schemas'

// Real replies recorded by tests/live/tutor.live.test.ts (batch G) must pass the app's checks,
// including the ones the checks of that time rejected, now that the harmless variations are accepted.

const FILE = join(import.meta.dirname, '..', 'fixtures', 'recorded', 'G-tutor.json')

interface Call {
  keys: string[]
  reply: string
  allowed: string[]
  rejected: string | null
}

describe.runIf(existsSync(FILE))('recorded tutor replies', () => {
  const recorded = JSON.parse(readFileSync(FILE, 'utf8')) as { calls: Call[] }

  it('every recorded reply passes validation', () => {
    for (const call of recorded.calls) {
      const allowed = new Set(call.allowed)
      if (call.keys.includes('covered')) {
        const parsed = parseLessonQuestions(call.reply, allowed)
        expect(parsed.questions.map((q) => q.kind).slice(0, 3)).toEqual(['opening', 'guided', 'partial'])
        expect(parsed.questions.every((q) => q.criteria.every((c, i) => c.id === `c${i + 1}`))).toBe(true)
        expect(parsed.questions.every((q) => !q.scaffold || !q.stem.includes(q.scaffold))).toBe(true)
      } else if (call.keys.includes('questions')) {
        const keys = [...new Set([...call.reply.matchAll(/"concept":\s*"(C\d+)"/g)].map((m) => m[1] as string))]
        expect(parseDiagnostic(call.reply, keys, allowed)).toHaveLength(keys.length * 2)
      } else {
        expect(parseExplanation(call.reply, allowed).outsideSources).toBe(false)
      }
    }
  })
})
