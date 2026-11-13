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
import { parsePromptFile, type PromptFile } from '../../src/main/knowledge/prompts'
import { extractionTask, matchTask, syllabusMapTask, syllabusParseTask, transcriptionTask, type MatchPair, type TocLine } from '../../src/main/knowledge/tasks'
import { createGeminiAdapter, ProviderService, UsageStore, type ModelTask, type ThinkingLevel } from '../../src/main/providers'
import { openDatabase, SessionStore, SettingsStore } from '../../src/main/storage'

// Real knowledge calls against Gemini, on openly licensed fixtures only (OpenStax pages and a
// syllabus written for this project). Opt-in: `npm run test:live` with FEYNMIND_LIVE_BATCH set to
// one batch; each batch states its number of calls. Every reply, with its estimate and actual
// tokens, is written to tests/fixtures/recorded/ for unit tests and for calibrating the prompts.
//
//   models  1 call   list models, to choose the cheapest flash-lite model that reads images
//   A       2 calls  transcribe the matrix page; extract concepts from section 1.1
//   B       2 calls  read the syllabus; match its units to the fixtures' sections
//   C       4 calls  transcribe the figure page; extract 1.2; extract 1.1 and 1.2 again at thinking "low"
//   D       2 calls  the same unclear pairs at thinking "minimal" and "low"
//   E       2 calls  the revised transcription prompt on the figure page; the revised syllabus prompt

const FIXTURES = join(import.meta.dirname, '..', 'fixtures')
const RECORDED = join(FIXTURES, 'recorded')
const PROMPTS = join(import.meta.dirname, '..', '..', 'prompts')
const live = process.env['FEYNMIND_LIVE'] === '1'
const batch = process.env['FEYNMIND_LIVE_BATCH'] ?? ''
/** The cheapest model that reads images, chosen in the "models" batch (pricing page, checked 2026-11-13). */
const MODEL = process.env['FEYNMIND_LIVE_MODEL'] ?? 'gemini-3.1-flash-lite'

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

let calls = 0
let lastUsage: unknown = null
let providers: ProviderService
let reader: IngestionReader
let sessionId: number
let toc: { key: string; line: TocLine; sectionIds: number[]; section: string | null }[] = []

async function record<T>(name: string, task: ModelTask<T>): Promise<T> {
  const before = calls
  const result = await providers.run(task)
  const record = {
    prompt: task.prompt.name,
    version: task.prompt.version,
    thinking: task.thinking,
    model: MODEL,
    estimate: task.estimate,
    usage: lastUsage,
    calls: calls - before,
    reply: result.value instanceof Map ? Object.fromEntries(result.value) : result.value
  }
  writeFileSync(join(RECORDED, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`)
  expect(calls - before).toBeLessThanOrEqual(3)
  return result.value
}

describe.runIf(live && batch !== '')(`knowledge (live, batch ${batch})`, () => {
  beforeAll(async () => {
    const apiKey = readKey()
    if (!apiKey) throw new Error('No GEMINI_API_KEY in the environment or .env.local')
    mkdirSync(RECORDED, { recursive: true })
    const work = mkdtempSync(join(tmpdir(), 'feynmind-live-'))
    const db = openDatabase(join(work, 'live.db'))
    const sessions = new SessionStore(db)
    sessionId = sessions.current().id
    sessions.setLimits(sessionId, { callCap: null, spendCapUsd: null })
    const settings = new SettingsStore(db)
    settings.set('provider.gemini.model', MODEL)
    const usageStore = new UsageStore(db)
    providers = new ProviderService({
      settings,
      encryptor: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
      createAdapter: (options) => {
        const adapter = createGeminiAdapter(options)
        return {
          ...adapter,
          listModels: () => {
            calls++
            return adapter.listModels()
          },
          generate: async (request) => {
            calls++
            const reply = await adapter.generate(request)
            lastUsage = reply.usage
            console.log(`call ${calls}: ${request.thinking ?? 'default'} thinking, ${reply.usage.inputTokens} in, ${reply.usage.outputTokens} out (${reply.usage.thinkingTokens} thinking)`)
            return reply
          }
        }
      },
      devKey: apiKey,
      loadPrompt: () => '',
      usage: usageStore,
      limits: (id) => sessions.limits(id)
    })

    // Ingest the two fixtures locally, as the app does (no model calls).
    const repo = new IngestionRepo(db)
    const materials = join(work, 'materials')
    await importFiles([join(FIXTURES, 'openstax-precalculus-text.pdf'), join(FIXTURES, 'openstax-precalculus-math-figures.pdf')], sessionId, repo, materials)
    const ocr = createTesseractOcr()
    await new IngestionRunner({ repo, materialsDir: materials, openDocument: (_, path) => openPdf(path), ocr, embedder: () => null, onProgress: () => {} }).run()
    await ocr.close()
    reader = new IngestionReader(repo)
    toc = reader.tableOfContents(sessionId).map((t, i) => ({
      key: t.key,
      sectionIds: t.sectionIds,
      section: t.section,
      line: { id: `T${i + 1}`, text: [t.fileName, t.chapter, t.section].filter(Boolean).join(' | ') + ` | pages ${t.pageStart.label ?? t.pageStart.index}-${t.pageEnd.label ?? t.pageEnd.index}` }
    }))
  }, 180_000)

  const ctx = () => ({ sessionId, jobId: null, calibration: { inputFactor: 1, outputFactor: 1, samples: 0 } })
  const sectionNamed = (text: string) => {
    const entry = toc.find((t) => t.section?.includes(text))
    const content = entry ? reader.sectionContent(entry.sectionIds[0] ?? -1) : undefined
    if (!content) throw new Error(`No section ${text} in the fixtures`)
    return content
  }
  const page = async (materialName: string, pageIndex: number) => {
    const entry = toc.find((t) => t.line.text.startsWith(materialName))
    const materialId = entry ? (reader.materialOfSection(entry.sectionIds[0] ?? -1) ?? -1) : -1
    const vision = reader.pageForVision(materialId, pageIndex)
    const sha = reader.materialSha(materialId)
    if (!vision || !sha) throw new Error('page not found')
    const doc = await openPdf(join(FIXTURES, materialName))
    const png = await doc.renderPage(pageIndex, 150)
    await doc.close()
    return { vision, sha, png: png ? new Uint8Array(png) : null }
  }

  it.runIf(batch === 'toc')('writes the fixtures’ table of contents, as the mapping call sees it (no calls)', () => {
    writeFileSync(join(RECORDED, 'toc.txt'), `${toc.map((t) => `${t.line.id} | ${t.line.text}`).join('\n')}\n`)
    expect(calls).toBe(0)
  })

  it.runIf(batch === 'dump')('writes the exact prompts of the recorded calls, for fitting the token estimate (no calls)', async () => {
    const m = await page('openstax-precalculus-math-figures.pdf', 1)
    const f = await page('openstax-precalculus-math-figures.pdf', 2)
    const tasks: [string, ModelTask<unknown>][] = [
      ['A-transcribe-matrix-page', transcriptionTask(prompt('page-transcribe'), m.vision, m.sha, null, ctx())],
      ['C-transcribe-figure-page', transcriptionTask(prompt('page-transcribe'), f.vision, f.sha, null, ctx())],
      ['A-extract-1.1-minimal', extractionTask(prompt('concept-extract'), sectionNamed('1.1'), ctx())],
      ['C-extract-1.2-minimal', extractionTask(prompt('concept-extract'), sectionNamed('1.2'), ctx())],
      ['B-syllabus-parse', syllabusParseTask(prompt('syllabus-parse'), readFileSync(join(FIXTURES, 'syllabus-precalculus.txt'), 'utf8'), ctx())]
    ]
    const dump = Object.fromEntries(tasks.map(([name, t]) => [name, { system: t.system, text: t.text, schema: JSON.stringify(t.jsonSchema) }]))
    writeFileSync(join(tmpdir(), 'feynmind-live-prompts.json'), JSON.stringify(dump))
    expect(calls).toBe(0)
  }, 120_000)

  it.runIf(batch === 'models')('lists models (1 call)', async () => {
    const ids = (await providers.listModels()).map((m) => m.id)
    console.log(ids.filter((id) => id.includes('flash-lite')).join(', '))
    expect(calls).toBe(1)
  }, 60_000)

  it.runIf(batch === 'A')('transcribes a matrix page and extracts section 1.1 (2 calls)', async () => {
    const p = await page('openstax-precalculus-math-figures.pdf', 1)
    const transcription = await record('A-transcribe-matrix-page', transcriptionTask(prompt('page-transcribe'), p.vision, p.sha, p.png, ctx()))
    console.log(transcription.blocks.map((b) => `[${b.fromLine}] ${b.text}`).join('\n'))
    const concepts = await record('A-extract-1.1-minimal', extractionTask(prompt('concept-extract'), sectionNamed('1.1'), ctx()))
    console.log(JSON.stringify(concepts, null, 1))
    expect(calls).toBe(2)
  }, 300_000)

  it.runIf(batch === 'B')('reads the syllabus and maps it to the fixtures (2 calls)', async () => {
    const text = readFileSync(join(FIXTURES, 'syllabus-precalculus.txt'), 'utf8')
    const parsed = await record('B-syllabus-parse', syllabusParseTask(prompt('syllabus-parse'), text, ctx()))
    console.log(JSON.stringify(parsed, null, 1))
    console.log(toc.map((t) => `${t.line.id} | ${t.line.text}`).join('\n'))
    const mapping = await record('B-syllabus-map', syllabusMapTask(prompt('syllabus-map'), parsed.units, toc.map((t) => t.line), ctx()))
    console.log(JSON.stringify(Object.fromEntries(mapping)))
    expect(calls).toBe(2)
  }, 300_000)

  it.runIf(batch === 'C')('calibrates transcription and compares thinking levels for extraction (4 calls)', async () => {
    const p = await page('openstax-precalculus-math-figures.pdf', 2)
    const t = await record('C-transcribe-figure-page', transcriptionTask(prompt('page-transcribe'), p.vision, p.sha, p.png, ctx()))
    console.log(t.blocks.map((b) => `[${b.fromLine}] ${b.text}`).join('\n'))
    for (const [name, section, thinking] of [
      ['C-extract-1.2-minimal', '1.2', undefined],
      ['C-extract-1.1-low', '1.1', 'low'],
      ['C-extract-1.2-low', '1.2', 'low']
    ] as const) {
      const concepts = await record(name, extractionTask(prompt('concept-extract', thinking), sectionNamed(section), ctx()))
      console.log(name, JSON.stringify(concepts.map((c) => [c.name, c.pages, c.prerequisites])))
    }
    expect(calls).toBe(4)
  }, 300_000)

  it.runIf(batch === 'E')('checks the revised transcription and syllabus prompts (2 calls)', async () => {
    const p = await page('openstax-precalculus-math-figures.pdf', 2)
    await record('E-transcribe-figure-page', transcriptionTask(prompt('page-transcribe'), p.vision, p.sha, p.png, ctx()))
    await record('E-syllabus-parse', syllabusParseTask(prompt('syllabus-parse'), readFileSync(join(FIXTURES, 'syllabus-precalculus.txt'), 'utf8'), ctx()))
    expect(calls).toBe(2)
  }, 300_000)

  it.runIf(batch === 'D')('answers the same unclear pairs at two thinking levels (2 calls)', async () => {
    const pairs = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'models', 'concept-pairs.json'), 'utf8')) as {
      concept: { same: [[string, string], [string, string]][]; different: [[string, string], [string, string]][] }
      prereq: { same: [string, string][]; different: [string, string][] }
    }
    const items: (MatchPair & { expected: boolean })[] = []
    const add = (kind: 'concept' | 'prerequisite', a: { name: string; definition: string | null }, b: { name: string; definition: string }, expected: boolean) =>
      items.push({ id: `${kind === 'concept' ? 'P' : 'Q'}${items.length + 1}`, kind, a, b, expected })
    for (const [x, y] of pairs.concept.same) add('concept', { name: x[0], definition: x[1] }, { name: y[0], definition: y[1] }, true)
    for (const [x, y] of pairs.concept.different) add('concept', { name: x[0], definition: x[1] }, { name: y[0], definition: y[1] }, false)
    for (const [x, y] of pairs.prereq.same) add('prerequisite', { name: x, definition: null }, { name: y, definition: `(the concept named "${y}")` }, true)
    for (const [x, y] of pairs.prereq.different) add('prerequisite', { name: x, definition: null }, { name: y, definition: `(the concept named "${y}")` }, false)
    for (const thinking of ['minimal', 'low'] as const) {
      const answers = await record(`D-match-${thinking}`, matchTask(prompt('concept-match', thinking), items, ctx()))
      const wrong = items.filter((p) => answers.get(p.id) !== p.expected)
      console.log(`${thinking}: ${items.length - wrong.length}/${items.length} right; wrong: ${wrong.map((p) => `${p.a.name} ~ ${p.b.name}`).join('; ')}`)
    }
    expect(calls).toBe(2)
  }, 300_000)
})
