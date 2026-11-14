import { z } from 'zod'
import { InvalidOutputError } from '../providers'

// The shape of every tutor reply, twice: a JSON schema sent to the model, and zod checks that the
// reply really has it. Citations must name pages of the passages that were sent. A reply that
// fails is never stored.

const citations = { type: 'array', items: { type: 'string' } }

export const DIAGNOSTIC_JSON_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          concept: { type: 'string' },
          purpose: { type: 'string', enum: ['probe', 'confirm'] },
          stem: { type: 'string' },
          choices: { type: 'array', items: { type: 'string' } },
          answer: { type: 'integer' },
          why: { type: 'string' },
          pages: citations
        },
        required: ['concept', 'purpose', 'stem', 'choices', 'answer', 'why', 'pages']
      }
    }
  },
  required: ['questions']
}

const criterionSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, text: { type: 'string' }, points: { type: 'integer' }, essential: { type: 'boolean' } },
  required: ['id', 'text', 'points', 'essential']
}

export const LESSON_QUESTIONS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    covered: { type: 'boolean' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['opening', 'guided', 'partial', 'unaided'] },
          stem: { type: 'string' },
          referenceAnswer: { type: 'string' },
          scaffold: { type: ['string', 'null'] },
          criteria: { type: 'array', items: criterionSchema },
          pages: citations
        },
        required: ['kind', 'stem', 'referenceAnswer', 'scaffold', 'criteria', 'pages']
      }
    }
  },
  required: ['covered', 'questions']
}

const gradeProperties = {
  criteria: {
    type: 'array',
    items: {
      type: 'object',
      properties: { id: { type: 'string' }, met: { type: 'string', enum: ['yes', 'partly', 'no'] }, evidence: { type: 'string' } },
      required: ['id', 'met', 'evidence']
    }
  },
  reason: { type: 'string' },
  feedback: { type: 'string' },
  pages: citations,
  outsideSources: { type: 'boolean' }
}

export const GRADE_JSON_SCHEMA = {
  type: 'object',
  properties: gradeProperties,
  required: ['criteria', 'reason', 'feedback', 'pages', 'outsideSources']
}

export const CONTEST_JSON_SCHEMA = {
  type: 'object',
  properties: { assessment: { type: 'string' }, changed: { type: 'boolean' }, ...gradeProperties },
  required: ['assessment', 'changed', 'criteria', 'reason', 'feedback', 'pages', 'outsideSources']
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

/**
 * A citation in the canonical form "S2 p. 17". Accepts the variants models write ("S2 p.17",
 * "S2, p. 17", "S2 page 17", "[S2 p. 17]") and keeps the first page of a range or list
 * ("S2 pp. 17-18" becomes "S2 p. 17"). Page labels such as "A-2" are kept whole.
 */
export function normalizeCitation(raw: string): string {
  const match = /^\[?\s*(S\d+)\s*,?\s*(?:pages?|pp?\.?)\s*(.+?)\s*\]?$/i.exec(raw.trim())
  if (!match?.[1] || !match[2]) return raw.trim()
  let page = match[2].split(/\s*[,;]\s*/)[0] ?? match[2]
  const range = /^(\d+)\s*[-–—]\s*\d+$/.exec(page)
  if (range?.[1]) page = range[1]
  return `${match[1].toUpperCase()} p. ${page}`
}

/** Rewrites every bracketed citation in a text into the canonical form. */
export function normalizeCitationsIn(text: string): string {
  return text.replace(/\[\s*S\d+\s*,?\s*(?:pages?|pp?\.?)\s*[^\]\n]{1,30}\]/gi, (cite) => `[${normalizeCitation(cite)}]`)
}

/** Citations, deduplicated; each must be one the passages allow. */
function checkCitations(pages: string[], allowed: Set<string>, where: string): string[] {
  const cleaned = [...new Set(pages.map(normalizeCitation))]
  const bad = cleaned.find((p) => !allowed.has(p))
  if (bad !== undefined) throw new InvalidOutputError(`${where} cites "${bad}", which is not a page of the passages`)
  return cleaned
}

// Diagnostic questions

export interface DiagnosticQuestion {
  concept: string
  purpose: 'probe' | 'confirm'
  stem: string
  choices: string[]
  answer: number
  why: string
  pages: string[]
}

/** Two questions per concept key, a probe and a confirm, each with four distinct choices. */
export function parseDiagnostic(text: string, conceptKeys: string[], allowed: Set<string>): DiagnosticQuestion[] {
  const value = check(
    z.object({
      questions: z.array(
        z.object({
          concept: z.string().trim(),
          purpose: z.enum(['probe', 'confirm']),
          stem: shortText(1500),
          choices: z.array(shortText(400)).length(4),
          answer: z.number().int().min(0).max(3),
          why: shortText(800),
          pages: z.array(z.string()).max(5)
        })
      )
    }),
    text
  )
  const result: DiagnosticQuestion[] = []
  for (const key of conceptKeys) {
    for (const purpose of ['probe', 'confirm'] as const) {
      const q = value.questions.find((x) => x.concept === key && x.purpose === purpose)
      if (!q) throw new InvalidOutputError(`no ${purpose} question for ${key}`)
      if (new Set(q.choices.map((c) => c.toLowerCase())).size !== 4) throw new InvalidOutputError(`a question for ${key} repeats a choice`)
      result.push({ ...q, pages: checkCitations(q.pages, allowed, `the ${purpose} question for ${key}`) })
    }
  }
  const unknown = value.questions.find((q) => !conceptKeys.includes(q.concept))
  if (unknown) throw new InvalidOutputError(`a question is for ${unknown.concept}, which was not asked for`)
  return result
}

// Lesson questions

export interface Criterion {
  id: string
  text: string
  points: number
  essential: boolean
}

export type LessonQuestionKind = 'opening' | 'guided' | 'partial' | 'unaided'

export interface LessonQuestion {
  kind: LessonQuestionKind
  stem: string
  referenceAnswer: string
  scaffold: string | null
  criteria: Criterion[]
  pages: string[]
}

export interface LessonQuestions {
  covered: boolean
  questions: LessonQuestion[]
}

const LESSON_PLAN: Record<LessonQuestionKind, number> = { opening: 1, guided: 1, partial: 1, unaided: 3 }

function criteriaSchema() {
  return z
    .array(z.object({ id: z.string().trim().max(200), text: shortText(400), points: z.number().int().min(1).max(3), essential: z.boolean() }))
    .min(1)
    .max(4)
}

/** One opening, one guided, one partial and three unaided questions; the first three types in that order. */
export function parseLessonQuestions(text: string, allowed: Set<string>, extraUnaidedOnly = false): LessonQuestions {
  const value = check(
    z.object({
      covered: z.boolean(),
      questions: z.array(
        z.object({
          kind: z.enum(['opening', 'guided', 'partial', 'unaided']),
          stem: shortText(2000),
          referenceAnswer: shortText(3000),
          scaffold: z.string().trim().max(3000).nullable(),
          criteria: criteriaSchema(),
          pages: z.array(z.string()).max(5)
        })
      )
    }),
    text
  )
  // The lesson needs exactly one opening, guided and partial question; extra ones of those kinds
  // are left out. Two to four unaided questions are kept (three are asked for).
  const plan: Partial<Record<LessonQuestionKind, number>> = extraUnaidedOnly ? { unaided: 3 } : LESSON_PLAN
  const kept: typeof value.questions = []
  for (const kind of Object.keys(LESSON_PLAN) as LessonQuestionKind[]) {
    const want = plan[kind] ?? 0
    const ofKind = value.questions.filter((q) => q.kind === kind)
    if (kind === 'unaided' && want > 0) {
      if (ofKind.length < 2) throw new InvalidOutputError(`expected ${want} unaided questions, got ${ofKind.length}`)
      kept.push(...ofKind.slice(0, 4))
    } else if (want > 0) {
      if (ofKind.length === 0) throw new InvalidOutputError(`expected a ${kind} question, got none`)
      kept.push(ofKind[0] as (typeof value.questions)[number])
    }
  }
  const questions = kept.map((q, i): LessonQuestion => {
    const where = `question ${i + 1} (${q.kind})`
    const scaffold = q.scaffold && q.scaffold !== '' ? q.scaffold : null
    if ((q.kind === 'guided' || q.kind === 'partial') && !scaffold) throw new InvalidOutputError(`${where} has no scaffold`)
    // Models sometimes repeat the scaffold at the end of the stem; it is shown separately.
    const stem = scaffold && q.stem.includes(scaffold) && q.stem.replace(scaffold, '').trim() !== '' ? q.stem.replace(scaffold, '').replace(/\s*(Fill in the blanks:?)?\s*$/i, '').trim() : q.stem
    return {
      ...q,
      stem,
      // Criterion ids are only keys for the grader: numbered here, whatever the model called them.
      criteria: q.criteria.map((c, j) => ({ ...c, id: `c${j + 1}` })),
      scaffold: q.kind === 'guided' || q.kind === 'partial' ? scaffold : null,
      pages: checkCitations(q.pages, allowed, where)
    }
  })
  if (value.covered && questions.every((q) => q.pages.length === 0)) throw new InvalidOutputError('the passages cover the concept but no question cites them')
  const order: Record<LessonQuestionKind, number> = { opening: 0, guided: 1, partial: 2, unaided: 3 }
  return { covered: value.covered, questions: questions.sort((a, b) => order[a.kind] - order[b.kind]) }
}

// Explanation

export const NOT_COVERED_NOTICE = '> Not covered by your materials'

export interface Explanation {
  markdown: string
  /** True when the tutor says some or all of it is not from the materials. */
  outsideSources: boolean
}

/** The streamed explanation: both headings, and only citations the passages allow (at least one unless it says it is not covered). */
export function parseExplanation(text: string, allowed: Set<string>): Explanation {
  const markdown = normalizeCitationsIn(text.trim())
  if (!/^#{1,3}\s+\**explanation\**:?\s*$/im.test(markdown)) throw new InvalidOutputError('the explanation has no "Explanation" heading')
  if (!/^#{1,3}\s+\**worked example\**:?\s*$/im.test(markdown)) throw new InvalidOutputError('the explanation has no "Worked example" heading')
  if (markdown.length > 20_000) throw new InvalidOutputError('the explanation is far too long')
  const cited = [...markdown.matchAll(/\[(S\d+ p\. [^\]\n]{1,20})\]/g)].map((m) => m[1] ?? '')
  const bad = cited.find((c) => !allowed.has(c))
  if (bad !== undefined) throw new InvalidOutputError(`the explanation cites "${bad}", which is not a page of the passages`)
  const outsideSources = markdown.includes(NOT_COVERED_NOTICE)
  if (!outsideSources && cited.length === 0 && allowed.size > 0) throw new InvalidOutputError('the explanation cites no page')
  return { markdown, outsideSources }
}

// Grades

export type Met = 'yes' | 'partly' | 'no'
export type Verdict = 'correct' | 'partial' | 'incorrect'

export interface CriterionResult {
  id: string
  met: Met
  evidence: string
}

export interface ModelGrade {
  criteria: CriterionResult[]
  reason: string
  feedback: string
  pages: string[]
  outsideSources: boolean
}

export interface ContestGrade extends ModelGrade {
  assessment: string
  changed: boolean
}

const gradeFields = {
  criteria: z.array(z.object({ id: z.string().trim(), met: z.enum(['yes', 'partly', 'no']), evidence: z.string().max(600) })),
  reason: shortText(800),
  feedback: z.string().trim().max(800),
  pages: z.array(z.string()).max(6),
  outsideSources: z.boolean()
}

function checkGrade<T extends ModelGrade>(value: T, rubric: Criterion[], allowed: Set<string>): T {
  const ids = rubric.map((c) => c.id)
  for (const id of ids) {
    const n = value.criteria.filter((c) => c.id === id).length
    if (n !== 1) throw new InvalidOutputError(n === 0 ? `criterion ${id} was not graded` : `criterion ${id} was graded twice`)
  }
  const extra = value.criteria.find((c) => !ids.includes(c.id))
  if (extra) throw new InvalidOutputError(`criterion ${extra.id} is not in the rubric`)
  const order = new Map(ids.map((id, i) => [id, i]))
  return { ...value, criteria: [...value.criteria].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)), pages: checkCitations(value.pages, allowed, 'the grade') }
}

export function parseGrade(text: string, rubric: Criterion[], allowed: Set<string>): ModelGrade {
  return checkGrade(check(z.object(gradeFields), text), rubric, allowed)
}

export function parseContest(text: string, rubric: Criterion[], allowed: Set<string>): ContestGrade {
  return checkGrade(check(z.object({ assessment: shortText(1000), changed: z.boolean(), ...gradeFields }), text), rubric, allowed)
}

/**
 * The verdict, computed from the criteria so that it never depends on the model's mood: score is
 * the share of points met (a criterion met partly counts half). Correct needs a score of at least
 * 0.85 and every essential criterion fully met; below 0.4 is incorrect; anything else is partly
 * correct. So a right answer with a wrong reason (an essential criterion missed) is partly correct.
 */
export function verdictOf(rubric: Criterion[], results: CriterionResult[]): { verdict: Verdict; score: number } {
  const met = new Map(results.map((r) => [r.id, r.met]))
  const total = rubric.reduce((n, c) => n + c.points, 0)
  const earned = rubric.reduce((n, c) => n + c.points * (met.get(c.id) === 'yes' ? 1 : met.get(c.id) === 'partly' ? 0.5 : 0), 0)
  const score = total === 0 ? 0 : earned / total
  const essentialsMet = rubric.every((c) => !c.essential || met.get(c.id) === 'yes')
  const verdict: Verdict = score >= 0.85 && essentialsMet ? 'correct' : score < 0.4 ? 'incorrect' : 'partial'
  return { verdict, score: Math.round(score * 1000) / 1000 }
}
