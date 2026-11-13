import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { importFiles } from '../../src/main/ingestion/importer'
import { createTesseractOcr } from '../../src/main/ingestion/ocr'
import { openPdf } from '../../src/main/ingestion/pdf'
import { rechunkSection, sectionsTouching } from '../../src/main/ingestion/rechunk'
import { IngestionRepo } from '../../src/main/ingestion/repo'
import { IngestionRunner } from '../../src/main/ingestion/runner'
import { searchPassages } from '../../src/main/ingestion/search'
import { openDatabase, SessionStore } from '../../src/main/storage'
import { MATCH_END, MATCH_START } from '../../src/shared/ingestion'
import { createFakeEmbedder } from './fakes/fakeEmbedder'
import { fixture } from './helpers'

// Search regression after pages are re-transcribed, on the math-and-figures fixture with the two
// transcriptions Gemini really returned for it (tests/fixtures/recorded). Words only in the
// transcription and words only in the original text layer must both still find their page.

const RECORDED = join(import.meta.dirname, '..', 'fixtures', 'recorded')
const blocksOf = (file: string): unknown => (JSON.parse(readFileSync(join(RECORDED, file), 'utf8')) as { reply: { blocks: unknown } }).reply.blocks

let workDir: string
let db: Database.Database
let repo: IngestionRepo
let sessionId: number
let materialId: number
const embedder = createFakeEmbedder()

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'feynmind-transcribed-'))
  db = openDatabase(join(workDir, 'test.db'))
  repo = new IngestionRepo(db)
  sessionId = new SessionStore(db).current().id
  await importFiles([fixture('openstax-precalculus-math-figures.pdf')], sessionId, repo, join(workDir, 'materials'))
  const ocr = createTesseractOcr()
  const runner = new IngestionRunner({ repo, materialsDir: join(workDir, 'materials'), openDocument: (_, p) => openPdf(p), ocr, embedder: () => embedder, onProgress: () => {} })
  await runner.run()
  materialId = repo.listMaterials(sessionId, true)[0]?.id ?? -1

  const insert = db.prepare("INSERT INTO page_transcripts (session_id, material_id, page_index, blocks, text, cache_key) VALUES (?, ?, ?, ?, '', 'recorded')")
  insert.run(sessionId, materialId, 1, JSON.stringify(blocksOf('A-transcribe-matrix-page.json')))
  insert.run(sessionId, materialId, 2, JSON.stringify(blocksOf('E-transcribe-figure-page.json')))
  for (const id of sectionsTouching(repo, materialId, [1, 2])) rechunkSection(repo, id)
  await runner.run()
  await ocr.close()
}, 120_000)

afterAll(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

const plain = (s: string): string => s.replaceAll(MATCH_START, '').replaceAll(MATCH_END, '')

describe('search over transcribed pages', () => {
  it('every chunk is embedded again and keeps its page numbers', () => {
    expect(repo.hasChunksToEmbed()).toBe(false)
    const ranges = db.prepare<[number], { s: number; e: number }>('SELECT page_start AS s, page_end AS e FROM chunks WHERE material_id = ?').all(materialId)
    expect(ranges.length).toBeGreaterThan(0)
    for (const r of ranges) expect(r.s >= 1 && r.e <= 2).toBe(true)
  })

  it('finds a page by words that exist only in its transcription', async () => {
    const { results } = await searchPassages(repo, sessionId, 'graph of y = csc x domain and range', embedder)
    expect(results[0]?.matchStart.index).toBe(2)
    expect(plain(results[0]?.context.focus ?? '')).toContain('csc')
  })

  it('finds a page by the book’s own wording of a worked example', async () => {
    const { results } = await searchPassages(repo, sessionId, 'Finding the Sum and Difference of Two 3 x 3 Matrices', embedder)
    expect(results[0]?.matchStart.index).toBe(1)
    expect(results[0]?.focusKind).toBe('wording')
  })

  it('still finds words that only the original text layer had', () => {
    const original = repo.pageTexts(materialId, 1, 1)
    const extracted = db.prepare<[number], { text: string }>('SELECT text FROM pages WHERE material_id = ? AND page_index = 1').get(materialId)?.text ?? ''
    const transcribed = (original[0]?.text ?? '').toLowerCase()
    const onlyOriginal = (extracted.toLowerCase().match(/[a-z]{4,}/g) ?? []).find((w) => !transcribed.includes(w))
    expect(onlyOriginal, 'a word of the text layer that the transcription does not repeat').toBeDefined()
    const hits = repo.keywordSearch(sessionId, `"${onlyOriginal}"`, 5)
    expect(hits.length).toBeGreaterThan(0)
    const pages = db.prepare<[number], { s: number }>('SELECT page_start AS s FROM chunks WHERE id = ?').get(hits[0] ?? -1)
    expect(pages?.s).toBe(1)
  })
})
