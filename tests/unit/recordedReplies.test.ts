import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseExtraction, parseMatch, parseSyllabus, parseTranscription } from '../../src/main/knowledge/schemas'

// Replies recorded from real Gemini calls (tests/live/knowledge.live.test.ts) must pass the same
// checks the app applies, so the checks are known to accept what the model actually sends.

const RECORDED = join(import.meta.dirname, '..', 'fixtures', 'recorded')

interface Recorded {
  prompt: string
  reply: unknown
  usage: { inputTokens: number; outputTokens: number } | null
}

const files = readdirSync(RECORDED).filter((f) => f.endsWith('.json'))
const load = (f: string): Recorded => JSON.parse(readFileSync(join(RECORDED, f), 'utf8')) as Recorded

describe('recorded replies', () => {
  it('are present for every kind of request', () => {
    const prompts = new Set(files.map((f) => load(f).prompt))
    expect([...prompts].sort()).toEqual(['concept-extract', 'concept-match', 'page-transcribe', 'syllabus-map', 'syllabus-parse'])
  })

  for (const file of files) {
    it(`${file} passes its check`, () => {
      const { prompt, reply, usage } = load(file)
      expect(usage?.inputTokens).toBeGreaterThan(0)
      const text = JSON.stringify(reply)
      switch (prompt) {
        case 'page-transcribe': {
          const blocks = (reply as { blocks: { fromLine: number }[] }).blocks
          expect(parseTranscription(text, Math.max(...blocks.map((b) => b.fromLine)) + 1).blocks.length).toBeGreaterThan(0)
          break
        }
        case 'concept-extract': {
          const concepts = reply as { pages: number[] }[]
          const pages = new Set(concepts.flatMap((c) => c.pages))
          expect(parseExtraction(JSON.stringify({ concepts: reply }), pages).length).toBe(concepts.length)
          break
        }
        case 'concept-match': {
          const answers = reply as Record<string, boolean>
          const ids = Object.keys(answers)
          expect(parseMatch(JSON.stringify({ answers: ids.map((pair) => ({ pair, same: answers[pair] })) }), ids).size).toBe(ids.length)
          break
        }
        case 'syllabus-parse':
          expect(parseSyllabus(text).units.length).toBeGreaterThan(0)
          break
        case 'syllabus-map':
          expect(Object.keys(reply as object).length).toBeGreaterThan(0)
          break
        default:
          throw new Error(`Unknown prompt ${prompt}`)
      }
    })
  }
})
