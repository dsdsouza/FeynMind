import { z } from 'zod'
import { InvalidOutputError } from '../providers'

// The shape of every reply, twice: a JSON schema sent to the model so it answers in that shape,
// and a zod schema plus checks that the reply really does. A reply that fails is never stored.

const nullableString = { type: ['string', 'null'] }
const nullableNumber = { type: ['number', 'null'] }

export const TRANSCRIPTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { fromLine: { type: 'integer' }, text: { type: 'string' } },
        required: ['fromLine', 'text']
      }
    }
  },
  required: ['blocks']
}

export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          definition: { type: 'string' },
          pages: { type: 'array', items: { type: 'integer' } },
          prerequisites: { type: 'array', items: { type: 'string' } }
        },
        required: ['name', 'definition', 'pages', 'prerequisites']
      }
    }
  },
  required: ['concepts']
}

export const MATCH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: { type: 'object', properties: { pair: { type: 'string' }, same: { type: 'boolean' } }, required: ['pair', 'same'] }
    }
  },
  required: ['answers']
}

export const SYLLABUS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          topics: { type: 'array', items: { type: 'string' } },
          startDate: nullableString,
          endDate: nullableString,
          examWeight: nullableNumber,
          readings: { type: 'array', items: { type: 'string' } }
        },
        required: ['title', 'topics', 'startDate', 'endDate', 'examWeight', 'readings']
      }
    },
    exams: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          date: nullableString,
          weight: nullableNumber,
          units: { type: 'array', items: { type: 'integer' } }
        },
        required: ['title', 'date', 'weight', 'units']
      }
    }
  },
  required: ['units', 'exams']
}

export const MAP_JSON_SCHEMA = {
  type: 'object',
  properties: {
    units: {
      type: 'array',
      items: { type: 'object', properties: { unit: { type: 'integer' }, toc: { type: 'array', items: { type: 'string' } } }, required: ['unit', 'toc'] }
    }
  },
  required: ['units']
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new InvalidOutputError('the reply was not JSON')
  }
}

function check<T>(schema: z.ZodType<T>, text: string): T {
  const result = schema.safeParse(parseJson(text))
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new InvalidOutputError(`${issue?.path.join('.') || 'reply'}: ${issue?.message ?? 'does not match'}`)
  }
  return result.data
}

const shortText = (max: number) => z.string().trim().min(1).max(max)

// Transcription

export interface Transcription {
  blocks: { fromLine: number; text: string }[]
}

export function parseTranscription(text: string, lineCount: number): Transcription {
  const value = check(z.object({ blocks: z.array(z.object({ fromLine: z.number().int(), text: z.string() })).max(400) }), text)
  const blocks = value.blocks.map((b) => ({ fromLine: b.fromLine, text: b.text.trim() })).filter((b) => b.text !== '')
  if (blocks.length === 0) throw new InvalidOutputError('the transcription is empty')
  const maxLine = Math.max(0, lineCount - 1)
  let previous = 0
  for (const block of blocks) {
    if (block.fromLine < 0 || block.fromLine > maxLine) throw new InvalidOutputError(`fromLine ${block.fromLine} is not a line of this page`)
    if (block.fromLine < previous) throw new InvalidOutputError('blocks are not in page order')
    previous = block.fromLine
  }
  if (blocks.reduce((n, b) => n + b.text.length, 0) > 30_000) throw new InvalidOutputError('the transcription is far longer than a page')
  return { blocks }
}

// Concept extraction

export interface ExtractedConcept {
  name: string
  definition: string
  pages: number[]
  prerequisites: string[]
}

const MAX_PREREQUISITES = 5

const IRREGULAR_PLURALS: Record<string, string> = {
  matrices: 'matrix',
  vertices: 'vertex',
  indices: 'index',
  simplices: 'simplex',
  bases: 'basis',
  axes: 'axis',
  hypotheses: 'hypothesis',
  theses: 'thesis',
  analyses: 'analysis',
  criteria: 'criterion',
  phenomena: 'phenomenon'
}

/** A rough singular form of an English word; good enough to compare concept names. */
function singular(word: string): string {
  const irregular = IRREGULAR_PLURALS[word]
  if (irregular) return irregular
  if (word.length <= 3) return word
  if (/ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`
  if (/(sses|ches|shes|xes)$/.test(word)) return word.slice(0, -2)
  if (/s$/.test(word) && !/(ss|us|is)$/.test(word)) return word.slice(0, -1)
  return word
}

/** Lower-cased, punctuation-free, singular form of a name, for spotting the same name written differently. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(the|a|an) /, '')
    .split(' ')
    .map(singular)
    .join(' ')
}

/**
 * Checks an extraction against the section it came from. Pages must be ones the section's
 * markers showed. Two entries with the same name are combined; a concept listed as its own
 * prerequisite has that link dropped.
 */
export function parseExtraction(text: string, sectionPages: Set<number>): ExtractedConcept[] {
  const value = check(
    z.object({
      concepts: z
        .array(
          z.object({
            name: shortText(100),
            definition: shortText(500),
            pages: z.array(z.number().int()).min(1),
            prerequisites: z.array(z.string())
          })
        )
        .max(40)
    }),
    text
  )
  const byName = new Map<string, ExtractedConcept>()
  for (const c of value.concepts) {
    const outside = c.pages.filter((p) => !sectionPages.has(p))
    if (outside.length > 0) throw new InvalidOutputError(`"${c.name}" cites page ${outside[0]}, which is not in this section`)
    const key = normalizeName(c.name)
    if (key === '') throw new InvalidOutputError('a concept has no name')
    const prerequisites = c.prerequisites.map((p) => p.trim()).filter((p) => p !== '' && p.length <= 100 && normalizeName(p) !== key)
    const existing = byName.get(key)
    if (existing) {
      existing.pages = [...new Set([...existing.pages, ...c.pages])].sort((a, b) => a - b)
      existing.prerequisites = [...new Set([...existing.prerequisites, ...prerequisites])]
    } else {
      byName.set(key, { name: c.name, definition: c.definition, pages: [...new Set(c.pages)].sort((a, b) => a - b), prerequisites: [...new Set(prerequisites)] })
    }
  }
  return [...byName.values()].map((c) => ({ ...c, prerequisites: c.prerequisites.slice(0, MAX_PREREQUISITES) }))
}

// Matching

export function parseMatch(text: string, pairIds: string[]): Map<string, boolean> {
  const value = check(z.object({ answers: z.array(z.object({ pair: z.string(), same: z.boolean() })) }), text)
  const answers = new Map<string, boolean>()
  for (const a of value.answers) {
    if (!pairIds.includes(a.pair)) throw new InvalidOutputError(`unknown pair ${a.pair}`)
    if (answers.has(a.pair)) throw new InvalidOutputError(`pair ${a.pair} answered twice`)
    answers.set(a.pair, a.same)
  }
  const missing = pairIds.filter((id) => !answers.has(id))
  if (missing.length > 0) throw new InvalidOutputError(`pair ${missing[0]} was not answered`)
  return answers
}

// Syllabus

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'not a real date')
const percent = z.number().min(0).max(100)

export interface ParsedSyllabus {
  units: { title: string; topics: string[]; startDate: string | null; endDate: string | null; examWeight: number | null; readings: string[] }[]
  exams: { title: string; date: string | null; weight: number | null; units: number[] }[]
}

export function parseSyllabus(text: string): ParsedSyllabus {
  const value = check(
    z.object({
      units: z
        .array(
          z.object({
            title: shortText(200),
            topics: z.array(shortText(300)).max(50),
            startDate: isoDate.nullable(),
            endDate: isoDate.nullable(),
            examWeight: percent.nullable(),
            readings: z.array(shortText(300)).max(30)
          })
        )
        .min(1)
        .max(80),
      exams: z.array(z.object({ title: shortText(200), date: isoDate.nullable(), weight: percent.nullable(), units: z.array(z.number().int()) })).max(30)
    }),
    text
  )
  for (const exam of value.exams) {
    const bad = exam.units.find((u) => u < 0 || u >= value.units.length)
    if (bad !== undefined) throw new InvalidOutputError(`exam "${exam.title}" covers unit ${bad}, which does not exist`)
  }
  for (const unit of value.units) {
    if (unit.startDate && unit.endDate && unit.endDate < unit.startDate) throw new InvalidOutputError(`unit "${unit.title}" ends before it starts`)
  }
  return value
}

export function parseMapping(text: string, unitCount: number, tocIds: Set<string>): Map<number, string[]> {
  const value = check(z.object({ units: z.array(z.object({ unit: z.number().int(), toc: z.array(z.string()) })) }), text)
  const result = new Map<number, string[]>()
  for (const u of value.units) {
    if (u.unit < 0 || u.unit >= unitCount) throw new InvalidOutputError(`unit ${u.unit} does not exist`)
    if (result.has(u.unit)) throw new InvalidOutputError(`unit ${u.unit} answered twice`)
    const unknown = u.toc.find((id) => !tocIds.has(id))
    if (unknown) throw new InvalidOutputError(`${unknown} is not in the table of contents`)
    result.set(u.unit, [...new Set(u.toc)])
  }
  for (let i = 0; i < unitCount; i++) if (!result.has(i)) throw new InvalidOutputError(`unit ${i} was not answered`)
  return result
}
