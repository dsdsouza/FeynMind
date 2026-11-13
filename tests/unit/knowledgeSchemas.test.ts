import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { InvalidOutputError } from '../../src/main/providers'
import { parsePromptFile, renderPrompt } from '../../src/main/knowledge/prompts'
import { normalizeName, parseExtraction, parseMapping, parseMatch, parseSyllabus, parseTranscription } from '../../src/main/knowledge/schemas'

const PROMPTS = join(import.meta.dirname, '..', '..', 'prompts')

describe('prompt files', () => {
  it('every knowledge prompt parses, and its placeholders are the documented ones', () => {
    const expected: Record<string, string[]> = {
      'page-transcribe': ['lines'],
      'concept-extract': ['book', 'chapter', 'section', 'text'],
      'concept-match': ['pairs'],
      'syllabus-parse': ['syllabus'],
      'syllabus-map': ['units', 'toc']
    }
    const files = readdirSync(PROMPTS).filter((f) => f !== 'connection-test.txt')
    expect(files.map((f) => f.replace('.txt', '')).sort()).toEqual(Object.keys(expected).sort())
    for (const [name, keys] of Object.entries(expected)) {
      const prompt = parsePromptFile(name, readFileSync(join(PROMPTS, `${name}.txt`), 'utf8'))
      expect(prompt.version).toBeGreaterThanOrEqual(1)
      expect(prompt.system.length).toBeGreaterThan(100)
      const values = Object.fromEntries(keys.map((k) => [k, `<${k}>`]))
      expect(() => renderPrompt(prompt, values)).not.toThrow()
    }
  })

  it('a change anywhere in a prompt changes its hash; line endings do not', () => {
    const raw = 'version: 1\nthinking: minimal\nmax-output-tokens: 10\noutput-base: 1\noutput-ratio: 1\n---system\nBe brief.\n---user\n{{x}}'
    const a = parsePromptFile('p', raw)
    expect(parsePromptFile('p', raw.replace(/\n/g, '\r\n')).hash).toBe(a.hash)
    expect(parsePromptFile('p', raw.replace('Be brief.', 'Be very brief.')).hash).not.toBe(a.hash)
    expect(parsePromptFile('p', raw.replace('version: 1', 'version: 2')).hash).not.toBe(a.hash)
  })

  it('rejects bad headers and mismatched placeholders', () => {
    expect(() => parsePromptFile('p', 'version: 1\n---system\nx\n---user\ny')).toThrow(/thinking/)
    expect(() => parsePromptFile('p', 'no parts at all')).toThrow(/---system/)
    const p = parsePromptFile('p', 'version: 1\nthinking: low\nmax-output-tokens: 10\noutput-base: 1\noutput-ratio: 1\n---system\nx\n---user\n{{a}}')
    expect(() => renderPrompt(p, {})).toThrow(/needs a value/)
    expect(() => renderPrompt(p, { a: '1', b: '2' })).toThrow(/no placeholder/)
  })
})

const json = (value: unknown): string => JSON.stringify(value)

describe('reply checks', () => {
  it('accepts a transcription in page order and rejects lines that do not exist or go backwards', () => {
    expect(parseTranscription(json({ blocks: [{ fromLine: 0, text: 'a' }, { fromLine: 2, text: '$x$' }] }), 3).blocks).toHaveLength(2)
    expect(() => parseTranscription(json({ blocks: [{ fromLine: 5, text: 'a' }] }), 3)).toThrow(InvalidOutputError)
    expect(() => parseTranscription(json({ blocks: [{ fromLine: 2, text: 'a' }, { fromLine: 1, text: 'b' }] }), 3)).toThrow(/order/)
    expect(() => parseTranscription(json({ blocks: [] }), 3)).toThrow(/empty/)
    expect(() => parseTranscription('{"blocks": [', 3)).toThrow(/not JSON/)
    // A page without extracted lines anchors every block at 0.
    expect(parseTranscription(json({ blocks: [{ fromLine: 0, text: '[Figure: x]' }] }), 0).blocks).toHaveLength(1)
  })

  it('checks extracted concepts against the section’s pages and tidies duplicates', () => {
    const pages = new Set([10, 11])
    const concepts = parseExtraction(
      json({
        concepts: [
          { name: 'Inverse matrix', definition: 'B with AB = I.', pages: [11, 10], prerequisites: ['matrix multiplication', 'inverse matrices', ''] },
          { name: 'inverse matrices', definition: 'dup', pages: [11], prerequisites: ['identity matrix'] }
        ]
      }),
      pages
    )
    expect(concepts).toEqual([{ name: 'Inverse matrix', definition: 'B with AB = I.', pages: [10, 11], prerequisites: ['matrix multiplication', 'identity matrix'] }])
    expect(() => parseExtraction(json({ concepts: [{ name: 'x', definition: 'y', pages: [99], prerequisites: [] }] }), pages)).toThrow(/page 99/)
    expect(() => parseExtraction(json({ concepts: [{ name: '', definition: 'y', pages: [10], prerequisites: [] }] }), pages)).toThrow(InvalidOutputError)
    expect(() => parseExtraction(json({ concepts: [{ name: 'x', pages: [10], prerequisites: [] }] }), pages)).toThrow(InvalidOutputError)
    expect(parseExtraction(json({ concepts: [] }), pages)).toEqual([])
  })

  it('requires an answer for every pair, once', () => {
    expect(parseMatch(json({ answers: [{ pair: 'P1', same: true }, { pair: 'P2', same: false }] }), ['P1', 'P2'])).toEqual(new Map([['P1', true], ['P2', false]]))
    expect(() => parseMatch(json({ answers: [{ pair: 'P1', same: true }] }), ['P1', 'P2'])).toThrow(/P2/)
    expect(() => parseMatch(json({ answers: [{ pair: 'P1', same: true }, { pair: 'P1', same: true }] }), ['P1'])).toThrow(/twice/)
    expect(() => parseMatch(json({ answers: [{ pair: 'P9', same: true }] }), ['P1'])).toThrow(/unknown/)
  })

  it('checks syllabus dates, weights and exam units', () => {
    const unit = { title: 'Vectors', topics: ['dot product'], startDate: '2026-09-01', endDate: '2026-09-12', examWeight: null, readings: ['1.1-1.3'] }
    expect(parseSyllabus(json({ units: [unit], exams: [{ title: 'Midterm', date: null, weight: 30, units: [0] }] })).units).toHaveLength(1)
    expect(() => parseSyllabus(json({ units: [{ ...unit, startDate: '2026-02-30' }], exams: [] }))).toThrow(InvalidOutputError)
    expect(() => parseSyllabus(json({ units: [{ ...unit, endDate: '2026-08-01' }], exams: [] }))).toThrow(/ends before/)
    expect(() => parseSyllabus(json({ units: [unit], exams: [{ title: 'Final', date: null, weight: 150, units: [] }] }))).toThrow(InvalidOutputError)
    expect(() => parseSyllabus(json({ units: [unit], exams: [{ title: 'Final', date: null, weight: 40, units: [3] }] }))).toThrow(/unit 3/)
    expect(() => parseSyllabus(json({ units: [], exams: [] }))).toThrow(InvalidOutputError)
  })

  it('requires every unit to be mapped, to known entries only', () => {
    const ids = new Set(['T1', 'T2'])
    expect(parseMapping(json({ units: [{ unit: 0, toc: ['T1', 'T1'] }, { unit: 1, toc: [] }] }), 2, ids)).toEqual(new Map([[0, ['T1']], [1, []]]))
    expect(() => parseMapping(json({ units: [{ unit: 0, toc: ['T7'] }] }), 1, ids)).toThrow(/T7/)
    expect(() => parseMapping(json({ units: [{ unit: 0, toc: [] }] }), 2, ids)).toThrow(/unit 1/)
  })

  it('normalizes names for comparison', () => {
    expect(normalizeName('The Inverse Matrices')).toBe(normalizeName('inverse matrix'))
    expect(normalizeName('Gauss–Jordan elimination')).toBe(normalizeName('gauss jordan elimination'))
    expect(normalizeName('cross product')).not.toBe(normalizeName('dot product'))
  })
})
