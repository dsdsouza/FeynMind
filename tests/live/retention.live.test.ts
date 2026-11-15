import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { importFiles } from '../../src/main/ingestion/importer'
import { createTesseractOcr } from '../../src/main/ingestion/ocr'
import { openPdf } from '../../src/main/ingestion/pdf'
import { IngestionReader } from '../../src/main/ingestion/reader'
import { IngestionRepo } from '../../src/main/ingestion/repo'
import { IngestionRunner } from '../../src/main/ingestion/runner'
import { parsePromptFile, type PromptFile } from '../../src/main/knowledge/prompts'
import { createGeminiAdapter, ProviderService, UsageStore, type GenerateRequest, type TokenUsage } from '../../src/main/providers'
import { openDatabase, SessionStore, SettingsStore } from '../../src/main/storage'
import { verdictOf, type Criterion } from '../../src/main/tutor'
import { LESSON_BUDGET, retrievePassages, type Passage } from '../../src/main/tutor/passages'
import { gradeTask, reteachTask, reviewQuestionsTask } from '../../src/main/tutor/tasks'

// Real calls for milestone 6a's two new prompts, on openly licensed fixtures only (OpenStax pages,
// and answers written for this project). Opt-in: FEYNMIND_LIVE_BATCH=<batch> with
// `node scripts/run-vitest.mjs --live run --config vitest.live.config.mts tests/live/retention.live.test.ts`.
//
//   R0   1 call    lists the models the key reaches (checks the cheapest model is still offered)
//   R1   3 calls   review-questions: three new variants each for "function", "domain" (text fixture)
//                  and "matrix addition" (math fixture), told the lesson questions already asked
//   R2   3 calls   reteach: a short re-teach after three wrong answers (one with flawed reasoning)
//   R3   6 calls   the unchanged grade prompt on answers written for R1's variants (2 right, 2 partly
//                  right, 2 wrong), to check that generated review rubrics grade as expected
//
// Each batch stops at a fixed ceiling (R0 1, R1 5, R2 5, R3 7), retries included. Replies are
// written to tests/fixtures/recorded/.

const FIXTURES = join(import.meta.dirname, '..', 'fixtures')
const RECORDED = join(FIXTURES, 'recorded')
const PROMPTS = join(import.meta.dirname, '..', '..', 'prompts')
const CASES = join(import.meta.dirname, '..', 'bench', 'review-grading-cases.json')
const live = process.env['FEYNMIND_LIVE'] === '1'
const batch = process.env['FEYNMIND_LIVE_BATCH'] ?? ''
const MODEL = process.env['FEYNMIND_LIVE_MODEL'] ?? 'gemini-3.1-flash-lite'
const CEILING: Record<string, number> = { R0: 1, R1: 5, R2: 5, R3: 7 }

interface Call {
  keys: string[]
  thinking: string
  usage: TokenUsage
  reply: string
  allowed: string[]
}

const calls: Call[] = []
let providers: ProviderService
let reader: IngestionReader
let repo: IngestionRepo
let db: ReturnType<typeof openDatabase>
let sessionId: number

function checkCeiling(): void {
  if (calls.length >= (CEILING[batch] ?? 0)) throw new Error(`Batch ${batch} reached its ceiling of ${CEILING[batch] ?? 0} requests; nothing more is sent.`)
}

function readKey(): string | null {
  if (process.env['GEMINI_API_KEY']) return process.env['GEMINI_API_KEY']
  try {
    return parseEnv(readFileSync('.env.local', 'utf8'))['GEMINI_API_KEY']?.trim() || null
  } catch {
    return null
  }
}

function prompt(name: string): PromptFile {
  return parsePromptFile(name, readFileSync(join(PROMPTS, `${name}.txt`), 'utf8').trim())
}

function capture(request: GenerateRequest, reply: { text: string; usage: TokenUsage }): void {
  const keys = request.jsonSchema ? Object.keys((request.jsonSchema['properties'] ?? {}) as object) : ['text']
  const allowed = [...new Set([...request.prompt.matchAll(/\[(S\d+ p\. [^\]]+)\]/g)].map((m) => m[1] as string))]
  calls.push({ keys, thinking: request.thinking ?? 'default', usage: reply.usage, reply: reply.text, allowed })
  console.log(`call ${calls.length}: ${keys.join(',')} (${request.thinking}), ${reply.usage.inputTokens} in, ${reply.usage.outputTokens} out (${reply.usage.thinkingTokens} thinking)`)
}

function materialId(name: string): number {
  const id = db.prepare<[string], { id: number }>('SELECT id FROM materials WHERE original_name = ?').get(name)?.id
  if (!id) throw new Error(`No material ${name}`)
  return id
}

async function passagesOn(file: string, pages: number[]): Promise<Passage[]> {
  const id = materialId(file)
  return retrievePassages({ reader, search: async () => ({ results: [], mode: 'keyword' }) }, sessionId, { name: '', definition: '', pages: pages.map((p) => ({ materialId: id, pageIndex: p })) }, LESSON_BUDGET)
}

const ctx = () => ({ sessionId, calibration: { inputFactor: 1, outputFactor: 1, samples: 0 } })

const TEXT = 'openstax-precalculus-text.pdf'
const MATH = 'openstax-precalculus-math-figures.pdf'

/** The concepts R1 and R2 use, with the lesson questions already asked (from the recorded G run, or written here for the matrix page). */
function concepts(): { key: string; name: string; definition: string; file: string; pages: number[]; asked: string[] }[] {
  const g = JSON.parse(readFileSync(join(RECORDED, 'G-tutor.json'), 'utf8')) as { lessons: Record<string, { questions: { stem: string }[] }> }
  const stems = (name: string) => g.lessons[name]?.questions.map((q) => q.stem) ?? []
  return [
    { key: 'function', name: 'function', definition: 'A relation in which each input value leads to exactly one output value.', file: TEXT, pages: [2], asked: stems('function') },
    {
      key: 'domain',
      name: 'domain',
      definition: 'The set of input values of a function; it excludes inputs that divide by zero or take an even root of a negative number.',
      file: TEXT,
      pages: [5, 6],
      asked: stems('domain')
    },
    {
      key: 'matrix-addition',
      name: 'matrix addition',
      definition: 'Adding two matrices of the same dimensions by adding their corresponding entries.',
      file: MATH,
      pages: [1],
      asked: ['Can a 2 by 3 matrix be added to a 3 by 2 matrix? Explain why.', 'Find A + B for A = [[1, 2], [3, 4]] and B = [[5, 6], [7, 8]].']
    }
  ]
}

describe.runIf(live && batch !== '')(`retention (live, batch ${batch})`, () => {
  beforeAll(async () => {
    const apiKey = readKey()
    if (!apiKey) throw new Error('No GEMINI_API_KEY in the environment or .env.local')
    mkdirSync(RECORDED, { recursive: true })
    const work = mkdtempSync(join(tmpdir(), 'feynmind-live-retention-'))
    db = openDatabase(join(work, 'live.db'))
    const sessions = new SessionStore(db)
    sessionId = sessions.current().id
    sessions.setLimits(sessionId, { callCap: null, spendCapUsd: null })
    const settings = new SettingsStore(db)
    settings.set('provider.gemini.model', MODEL)
    providers = new ProviderService({
      settings,
      encryptor: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
      createAdapter: (options) => {
        const adapter = createGeminiAdapter(options)
        return {
          ...adapter,
          listModels: async () => {
            checkCeiling()
            const models = await adapter.listModels()
            calls.push({ keys: ['list'], thinking: 'none', usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 }, reply: models.map((m) => m.id).join(','), allowed: [] })
            return models
          },
          generate: async (request) => {
            checkCeiling()
            const reply = await adapter.generate(request)
            capture(request, reply)
            return reply
          },
          stream: async (request, onText) => {
            checkCeiling()
            const reply = await adapter.stream(request, onText)
            capture(request, reply)
            return reply
          }
        }
      },
      devKey: apiKey,
      loadPrompt: () => '',
      usage: new UsageStore(db),
      limits: (id) => sessions.limits(id)
    })
    if (batch === 'R0') return
    repo = new IngestionRepo(db)
    const materials = join(work, 'materials')
    await importFiles([join(FIXTURES, TEXT), join(FIXTURES, MATH)], sessionId, repo, materials)
    const ocr = createTesseractOcr()
    await new IngestionRunner({ repo, materialsDir: materials, openDocument: (_, path) => openPdf(path), ocr, embedder: () => null, onProgress: () => {} }).run()
    await ocr.close()
    reader = new IngestionReader(repo)
  }, 180_000)

  it.runIf(batch === 'R0')('lists the models the key reaches (1 call)', async () => {
    const models = await providers.listModels()
    writeFileSync(join(RECORDED, 'R0-models.json'), `${JSON.stringify({ models: models.map((m) => m.id) }, null, 2)}\n`)
    expect(models.map((m) => m.id)).toContain(MODEL)
  }, 60_000)

  it.runIf(batch === 'R1')('writes three review variants for each of three concepts (3 calls)', async () => {
    const out: Record<string, unknown> = {}
    try {
      for (const c of concepts()) {
        const passages = await passagesOn(c.file, c.pages)
        const task = reviewQuestionsTask(prompt('review-questions'), { name: c.name, definition: c.definition, prerequisites: [] }, passages, c.asked, ctx())
        const result = await providers.run(task)
        out[c.key] = { asked: c.asked, passages: passages.map((p) => ({ tag: p.tag, pages: p.pages })), ...result.value }
      }
    } finally {
      writeFileSync(join(RECORDED, 'R1-review-questions.json'), `${JSON.stringify({ model: MODEL, calls, concepts: out }, null, 2)}\n`)
    }
    expect(calls.length).toBeLessThanOrEqual(CEILING['R1'] ?? 0)
  }, 300_000)

  it.runIf(batch === 'R2')('re-teaches after three wrong answers (3 calls)', async () => {
    const [fn, domain, matrix] = concepts()
    const cases = [
      {
        concept: fn,
        question: 'Determine if the set {(0, 1), (1, 1), (2, 1), (3, 1)} is a function. Explain your reasoning.',
        reference: 'Yes. Each input (0, 1, 2, 3) has exactly one output; outputs may repeat.',
        answer: 'No, it is not a function because the output 1 repeats.',
        reasoning: '',
        feedback: 'Verdict: incorrect\nReason: A function allows the same output for different inputs; what it forbids is one input with two outputs. Every input here has one output, so it is a function.'
      },
      {
        concept: domain,
        question: 'Find the domain of the function f(x) = 1 / (x^2 - 9).',
        reference: 'All real numbers except x = 3 and x = -3, since x^2 - 9 = 0 there.',
        answer: 'All real numbers except 3.',
        reasoning: 'x^2 - 9 is zero when x is the square root of 9, which is 3.',
        feedback: 'Verdict: partial\nReason: You excluded 3 but not -3.\nOn the reasoning (flawed): x^2 = 9 has two solutions, 3 and -3; taking only the positive square root loses one.'
      },
      {
        concept: matrix,
        question: 'Can a 2 by 3 matrix be added to a 3 by 2 matrix? Explain why.',
        reference: 'No. Matrices can be added only when they have the same dimensions, so corresponding entries exist.',
        answer: '',
        reasoning: '',
        feedback: 'Verdict: incorrect\nReason: You chose "I don\'t know".'
      }
    ]
    const out: unknown[] = []
    try {
      for (const c of cases) {
        if (!c.concept) throw new Error('missing concept')
        const passages = await passagesOn(c.concept.file, c.concept.pages)
        const task = reteachTask(
          prompt('reteach'),
          { name: c.concept.name, definition: c.concept.definition, prerequisites: [] },
          passages,
          { question: c.question, referenceAnswer: c.reference, answer: c.answer, reasoning: c.reasoning, feedback: c.feedback },
          ctx()
        )
        const result = await providers.runStream(task, () => undefined, () => undefined)
        const words = result.value.markdown.split(/\s+/).filter(Boolean).length
        out.push({ concept: c.concept.key, question: c.question, answer: c.answer, reasoning: c.reasoning, words, ...result.value })
      }
    } finally {
      writeFileSync(join(RECORDED, 'R2-reteach.json'), `${JSON.stringify({ model: MODEL, calls, cases: out }, null, 2)}\n`)
    }
    expect(calls.length).toBeLessThanOrEqual(CEILING['R2'] ?? 0)
  }, 300_000)

  it.runIf(batch === 'R3')('grades written answers to the generated variants with the unchanged grade prompt (6 calls)', async () => {
    if (!existsSync(CASES)) throw new Error('Write tests/bench/review-grading-cases.json from the R1 recording first.')
    const r1 = JSON.parse(readFileSync(join(RECORDED, 'R1-review-questions.json'), 'utf8')) as {
      concepts: Record<string, { questions: { stem: string; referenceAnswer: string; criteria: Criterion[] }[] }>
    }
    const cases = JSON.parse(readFileSync(CASES, 'utf8')) as { id: string; concept: string; question: number; expected: string; answer: string }[]
    const byKey = new Map(concepts().map((c) => [c.key, c]))
    const out: unknown[] = []
    try {
      for (const c of cases) {
        const concept = byKey.get(c.concept)
        const q = r1.concepts[c.concept]?.questions[c.question]
        if (!concept || !q) throw new Error(`No question ${c.question} for ${c.concept}`)
        const passages = await passagesOn(concept.file, concept.pages)
        const task = gradeTask(prompt('grade'), { question: q.stem, referenceAnswer: q.referenceAnswer, criteria: q.criteria, passages, answer: c.answer, reasoning: '' }, ctx())
        const result = await providers.run(task)
        const { verdict } = verdictOf(q.criteria, result.value.criteria)
        out.push({ id: c.id, expected: c.expected, verdict, agrees: verdict === c.expected, grade: result.value })
      }
    } finally {
      writeFileSync(join(RECORDED, 'R3-review-grading.json'), `${JSON.stringify({ model: MODEL, calls, cases: out }, null, 2)}\n`)
    }
    expect(calls.length).toBeLessThanOrEqual(CEILING['R3'] ?? 0)
  }, 300_000)
})
