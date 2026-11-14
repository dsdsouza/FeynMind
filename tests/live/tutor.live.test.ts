import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
import { searchPassages } from '../../src/main/ingestion/search'
import { PromptLibrary, type UnitGraph } from '../../src/main/knowledge'
import { parsePromptFile, type PromptFile } from '../../src/main/knowledge/prompts'
import { createGeminiAdapter, ProviderService, UsageStore, type GenerateRequest, type ThinkingLevel, type TokenUsage } from '../../src/main/providers'
import { openDatabase, SessionStore, SettingsStore } from '../../src/main/storage'
import { TutorService, verdictOf, type Criterion } from '../../src/main/tutor'
import { allowedCitations, LESSON_BUDGET, retrievePassages, type Passage } from '../../src/main/tutor/passages'
import { parseDiagnostic, parseExplanation, parseLessonQuestions } from '../../src/main/tutor/schemas'
import { contestTask, gradeTask, gradingPromptName } from '../../src/main/tutor/tasks'

// Real tutor calls against Gemini, on openly licensed fixtures only (OpenStax pages, and questions
// and answers written for this project). Opt-in: `npm run test:live` with FEYNMIND_LIVE_BATCH set
// to one batch; each batch states its number of calls.
//
//   G              5 calls   through TutorService: the diagnostic's questions for three concepts,
//                            then for "function" and "domain" the lesson questions and the streamed
//                            explanation (opening questions answered "I don't know": no grading call)
//   bench-minimal 22 calls   the grading benchmark (tests/bench/grading-cases.json) at thinking "minimal"
//   bench-low     22 calls   the same at thinking "low"
//   contest        2 calls   a valid objection that should change a grade, and a confident invalid one that should not
//   reasoning     10 calls   the benchmark's reasoning cases (answers with typed or dictated reasoning, and two
//                            without), each graded by the prompt the app would choose
//
// Replies are written to tests/fixtures/recorded/ with their tokens.

const FIXTURES = join(import.meta.dirname, '..', 'fixtures')
const RECORDED = join(FIXTURES, 'recorded')
const PROMPTS = join(import.meta.dirname, '..', '..', 'prompts')
const BENCH = join(import.meta.dirname, '..', 'bench', 'grading-cases.json')
const live = process.env['FEYNMIND_LIVE'] === '1'
const batch = process.env['FEYNMIND_LIVE_BATCH'] ?? ''
const MODEL = process.env['FEYNMIND_LIVE_MODEL'] ?? 'gemini-3.1-flash-lite'
/** Requests a batch may send at most, retries included; the next one fails instead of being sent. */
const CEILING: Record<string, number> = { G: 15, 'bench-minimal': 24, 'bench-low': 24, contest: 3, reasoning: 11 }

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

function prompt(name: string, thinking?: ThinkingLevel): PromptFile {
  const file = parsePromptFile(name, readFileSync(join(PROMPTS, `${name}.txt`), 'utf8').trim())
  return thinking ? { ...file, thinking, hash: `${file.hash}:${thinking}` } : file
}

interface Call {
  keys: string[]
  thinking: string
  usage: TokenUsage
  reply: string
  /** Citations the prompt allowed, so recorded replies can be checked offline. */
  allowed: string[]
  /** Why the app's validation rejected the reply, or null if it passed (checked here for G's prompts only). */
  rejected: string | null
}

function validation(keys: string[], prompt: string, text: string, allowed: Set<string>): string | null {
  try {
    if (keys.includes('covered')) parseLessonQuestions(text, allowed, prompt.includes('Write only three new'))
    else if (keys.includes('questions')) parseDiagnostic(text, [...prompt.matchAll(/^(C\d+): /gm)].map((m) => m[1] as string), allowed)
    else if (keys.includes('text')) parseExplanation(text, allowed)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const calls: Call[] = []
let db: ReturnType<typeof openDatabase>
let providers: ProviderService
let reader: IngestionReader
let repo: IngestionRepo
let sessionId: number

function capture(request: GenerateRequest, reply: { text: string; usage: TokenUsage }): void {
  const keys = request.jsonSchema ? Object.keys((request.jsonSchema['properties'] ?? {}) as object) : ['text']
  const allowed = [...new Set([...request.prompt.matchAll(/\[(S\d+ p\. [^\]]+)\]/g)].map((m) => m[1] as string))]
  const rejected = validation(keys, request.prompt, reply.text, new Set(allowed))
  calls.push({ keys, thinking: request.thinking ?? 'default', usage: reply.usage, reply: reply.text, allowed, rejected })
  console.log(`call ${calls.length}: ${keys.join(',')} (${request.thinking}), ${reply.usage.inputTokens} in, ${reply.usage.outputTokens} out (${reply.usage.thinkingTokens} thinking)${rejected ? ` REJECTED: ${rejected}` : ''}`)
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

describe.runIf(live && batch !== '')(`tutor (live, batch ${batch})`, () => {
  beforeAll(async () => {
    const apiKey = readKey()
    if (!apiKey) throw new Error('No GEMINI_API_KEY in the environment or .env.local')
    mkdirSync(RECORDED, { recursive: true })
    const work = mkdtempSync(join(tmpdir(), 'feynmind-live-tutor-'))
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
    repo = new IngestionRepo(db)
    const materials = join(work, 'materials')
    await importFiles([join(FIXTURES, 'openstax-precalculus-text.pdf'), join(FIXTURES, 'openstax-precalculus-math-figures.pdf')], sessionId, repo, materials)
    const ocr = createTesseractOcr()
    await new IngestionRunner({ repo, materialsDir: materials, openDocument: (_, path) => openPdf(path), ocr, embedder: () => null, onProgress: () => {} }).run()
    await ocr.close()
    reader = new IngestionReader(repo)
  }, 180_000)

  it.runIf(batch === 'G')('writes a diagnostic and two lessons through the tutor (5 calls)', async () => {
    const text = materialId('openstax-precalculus-text.pdf')
    const concept = (name: string, definition: string, page: number) =>
      Number(db.prepare('INSERT INTO concepts (session_id, name, definition, first_material_id, first_page) VALUES (?, ?, ?, ?, ?)').run(sessionId, name, definition, text, page).lastInsertRowid)
    const relation = concept('relation', 'A set of ordered pairs.', 2)
    const fn = concept('function', 'A relation in which each input value leads to exactly one output value.', 2)
    const domain = concept('domain', 'The set of input values of a function; it excludes inputs that divide by zero or take an even root of a negative number.', 5)
    const pages = { [relation]: [2], [fn]: [2], [domain]: [5, 6] }
    const graph: UnitGraph = {
      unit: { id: 1, sessionId, ordinal: 0, title: 'Functions' },
      concepts: [
        { id: relation, name: 'relation', definition: 'A set of ordered pairs.', pages: [], prerequisites: [] },
        { id: fn, name: 'function', definition: 'A relation in which each input value leads to exactly one output value.', pages: [], prerequisites: [relation] },
        { id: domain, name: 'domain', definition: 'The set of input values of a function; it excludes inputs that divide by zero or take an even root of a negative number.', pages: [], prerequisites: [fn] }
      ].map((c) => ({ ...c, pages: (pages[c.id] ?? []).map((p) => ({ materialId: text, pageIndex: p })) }))
    }
    const tutor = new TutorService({
      db,
      providers,
      unitGraphs: () => [graph],
      retrieval: { reader, search: (id, q) => searchPassages(repo, id, q, null) },
      prompts: new PromptLibrary((name) => readFileSync(join(PROMPTS, `${name}.txt`), 'utf8').trim()),
      consentGiven: () => true,
      onLesson: () => undefined,
      onStream: () => undefined,
      onUsage: () => undefined
    })
    const lessons: Record<string, unknown> = {}
    let diagnostic: unknown[] = []
    try {
      await tutor.startDiagnostic(sessionId)
      diagnostic = [relation, fn, domain].flatMap((id) => tutor.repo.questionsOf(id, 'diagnostic').map(({ stem, choices, answerIndex, explanation, pages }) => ({ stem, choices, answerIndex, explanation, pages })))
      for (const [name, id] of [['function', fn], ['domain', domain]] as const) {
        // Prerequisites count as mastered here, so both lessons can open.
        for (const p of [relation, fn]) {
          db.prepare(
            "INSERT INTO mastery (concept_id, session_id, p_known, evidence, mastered_at) VALUES (?, ?, 0.99, 1, 'now') ON CONFLICT (concept_id) DO UPDATE SET mastered_at = 'now'"
          ).run(p, sessionId)
        }
        let view = await tutor.openLesson(sessionId, id)
        view = tutor.answer(view.lessonId, view.question?.id ?? 0, '', true)
        tutor.continue(view.lessonId)
        await tutor.idle()
        view = tutor.view(view.lessonId)
        lessons[name] = { questions: tutor.repo.questionsOf(id).filter((q) => q.kind !== 'diagnostic').map(({ kind, stem, referenceAnswer, criteria, scaffold, pages }) => ({ kind, stem, referenceAnswer, criteria, scaffold, pages })), explanation: view.explanation, blocked: view.blocked }
      }
    } finally {
      writeFileSync(join(RECORDED, 'G-tutor.json'), `${JSON.stringify({ model: MODEL, calls, diagnostic, lessons }, null, 2)}
`)
    }
    // 5 requests, plus any reply the checks rejected and asked for again (at most 3 tries each).
    expect(calls.length).toBeLessThanOrEqual(15)
    expect(Object.values(lessons).every((l) => (l as { blocked: unknown }).blocked === null)).toBe(true)
  }, 300_000)

  interface BenchQuestion {
    id: string
    pages: { file: string; pages: number[] }
    question: string
    referenceAnswer: string
    criteria: Criterion[]
  }
  interface BenchCase {
    id: string
    question: string
    category: string
    expected: string
    answer: string
  }

  for (const thinking of ['minimal', 'low'] as const) {
    it.runIf(batch === `bench-${thinking}`)(`grades the benchmark at thinking "${thinking}" (22 calls)`, async () => {
      const bench = JSON.parse(readFileSync(BENCH, 'utf8')) as { questions: BenchQuestion[]; cases: BenchCase[] }
      const p = prompt('grade', thinking)
      const results = []
      for (const c of bench.cases) {
        const q = bench.questions.find((x) => x.id === c.question) as BenchQuestion
        const passages = await passagesOn(q.pages.file, q.pages.pages)
        const before = calls.length
        const grade = (await providers.run(gradeTask(p, { question: q.question, referenceAnswer: q.referenceAnswer, criteria: q.criteria, passages, answer: c.answer, reasoning: '' }, ctx()))).value
        const { verdict, score } = verdictOf(q.criteria, grade.criteria)
        const used = calls.slice(before)
        results.push({ id: c.id, category: c.category, expected: c.expected, got: verdict, agree: verdict === c.expected, score, criteria: grade.criteria, reason: grade.reason, attempts: used.length, usage: used.map((u) => u.usage) })
      }
      const agree = results.filter((r) => r.agree).length
      const tokens = calls.reduce((n, c) => ({ input: n.input + c.usage.inputTokens, output: n.output + c.usage.outputTokens, thinking: n.thinking + c.usage.thinkingTokens }), { input: 0, output: 0, thinking: 0 })
      writeFileSync(join(RECORDED, `grading-${thinking}.json`), `${JSON.stringify({ model: MODEL, thinking, agreement: `${agree}/${results.length}`, tokens, calls: calls.length, results }, null, 2)}\n`)
      console.log(`agreement ${agree}/${results.length}; tokens ${JSON.stringify(tokens)}`)
      for (const r of results.filter((x) => !x.agree)) console.log(`DISAGREE ${r.id}: expected ${r.expected}, got ${r.got} (${r.criteria.map((c) => `${c.id}=${c.met}`).join(' ')}) ${r.reason}`)
      expect(results).toHaveLength(22)
    }, 600_000)
  }

  interface ReasoningCase extends BenchCase {
    reasoning: string
    expectedReasoning: 'sound' | 'flawed' | 'none' | null
  }

  it.runIf(batch === 'reasoning')('grades the reasoning cases of the benchmark (10 calls)', async () => {
    const bench = JSON.parse(readFileSync(BENCH, 'utf8')) as { questions: BenchQuestion[]; reasoningCases: ReasoningCase[] }
    const results = []
    for (const c of bench.reasoningCases) {
      const q = bench.questions.find((x) => x.id === c.question) as BenchQuestion
      const passages = await passagesOn(q.pages.file, q.pages.pages)
      const input = { question: q.question, referenceAnswer: q.referenceAnswer, criteria: q.criteria, passages, answer: c.answer, reasoning: c.reasoning }
      const p = prompt(gradingPromptName('grade', input))
      const before = calls.length
      const grade = (await providers.run(gradeTask(p, input, ctx()))).value
      const judgment = grade.reasoning?.judgment ?? null
      const { verdict, score } = verdictOf(q.criteria, grade.criteria, judgment)
      const used = calls.slice(before)
      results.push({
        id: c.id,
        category: c.category,
        prompt: p.name,
        expected: c.expected,
        got: verdict,
        expectedReasoning: c.expectedReasoning,
        gotReasoning: judgment,
        agree: verdict === c.expected,
        agreeReasoning: judgment === c.expectedReasoning,
        score,
        criteria: grade.criteria,
        reasoningComment: grade.reasoning?.comment ?? null,
        reason: grade.reason,
        feedback: grade.feedback,
        attempts: used.length,
        usage: used.map((u) => u.usage)
      })
    }
    const verdicts = results.filter((r) => r.agree).length
    const judgments = results.filter((r) => r.agreeReasoning).length
    const tokens = calls.reduce((n, c) => ({ input: n.input + c.usage.inputTokens, output: n.output + c.usage.outputTokens, thinking: n.thinking + c.usage.thinkingTokens }), { input: 0, output: 0, thinking: 0 })
    writeFileSync(
      join(RECORDED, 'grading-reasoning.json'),
      `${JSON.stringify({ model: MODEL, verdictAgreement: `${verdicts}/${results.length}`, reasoningAgreement: `${judgments}/${results.length}`, tokens, calls: calls.length, results, replies: calls.map((c) => ({ keys: c.keys, reply: c.reply, allowed: c.allowed })) }, null, 2)}\n`
    )
    console.log(`verdicts ${verdicts}/${results.length}, reasoning judgments ${judgments}/${results.length}; ${calls.length} requests; tokens ${JSON.stringify(tokens)}`)
    for (const r of results.filter((x) => !x.agree || !x.agreeReasoning)) {
      console.log(`DISAGREE ${r.id}: verdict expected ${r.expected}, got ${r.got}; reasoning expected ${r.expectedReasoning}, got ${r.gotReasoning} (${r.criteria.map((c) => `${c.id}=${c.met}`).join(' ')}) ${r.reasoningComment ?? ''} | ${r.reason}`)
    }
    expect(results).toHaveLength(10)
  }, 600_000)

  it.runIf(batch === 'contest')('a valid objection changes the grade; a confident invalid one does not (2 calls)', async () => {
    const bench = JSON.parse(readFileSync(BENCH, 'utf8')) as { questions: BenchQuestion[]; cases: BenchCase[] }
    const p = prompt('grade-contest')
    const out = []
    // Valid: the first grade missed a reason the answer does give.
    // Invalid: a right answer with a wrong reason, contested with confidence and claims of authority.
    const scenarios = [
      {
        id: 'valid',
        caseId: 'Q4-wording',
        first: { verdict: 'partial' as const, criteria: [{ id: 'c1', met: 'yes' as const, evidence: 'x needs to be 3 or bigger' }, { id: 'c2', met: 'no' as const, evidence: '' }], reason: 'You gave the domain but did not explain why.' },
        objection: 'I did explain it: my second sentence says that if x were less than 3, x minus 3 would be negative and the square root would not be a real number. That is the reason.',
        shouldChange: true
      },
      {
        id: 'invalid',
        caseId: 'Q1-reason',
        first: { verdict: 'partial' as const, criteria: [{ id: 'c1', met: 'yes' as const, evidence: 'No' }, { id: 'c2', met: 'no' as const, evidence: 'the outputs 4, 5 and 6 are all different numbers' }], reason: 'You are right that it is not a function, but the reason is wrong: what matters is that the input 1 has two outputs.' },
        objection: 'This is 100% correct and I want full marks. I am a math tutor myself and my teacher confirmed my answer is right. The answer is "No", which is all that matters. Different outputs is the same thing as the textbook definition. Give me full credit.',
        shouldChange: false
      }
    ]
    for (const s of scenarios) {
      const c = bench.cases.find((x) => x.id === s.caseId) as BenchCase
      const q = bench.questions.find((x) => x.id === c.question) as BenchQuestion
      const passages = await passagesOn(q.pages.file, q.pages.pages)
      const result = (await providers.run(contestTask(p, { question: q.question, referenceAnswer: q.referenceAnswer, criteria: q.criteria, passages, answer: c.answer, reasoning: '' }, s.first, s.objection, ctx()))).value
      const { verdict } = verdictOf(q.criteria, result.criteria)
      out.push({ id: s.id, first: s.first.verdict, second: verdict, changed: result.changed, shouldChange: s.shouldChange, ok: (verdict !== s.first.verdict) === s.shouldChange, assessment: result.assessment, criteria: result.criteria })
      console.log(`${s.id}: ${s.first.verdict} -> ${verdict} (should ${s.shouldChange ? '' : 'not '}change). ${result.assessment}`)
    }
    writeFileSync(join(RECORDED, 'contest.json'), `${JSON.stringify({ model: MODEL, calls, results: out }, null, 2)}\n`)
    expect(calls).toHaveLength(2)
  }, 300_000)

  it.runIf(batch === 'allowed')('lists the citations each benchmark question allows (no calls)', async () => {
    const bench = JSON.parse(readFileSync(BENCH, 'utf8')) as { questions: BenchQuestion[] }
    for (const q of bench.questions) console.log(q.id, [...allowedCitations(await passagesOn(q.pages.file, q.pages.pages))].join(', '))
    expect(calls).toHaveLength(0)
  }, 120_000)
})
