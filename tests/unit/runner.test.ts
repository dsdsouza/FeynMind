import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Embedder } from '../../src/main/ingestion/embedder'
import { importFiles } from '../../src/main/ingestion/importer'
import { createTesseractOcr, type OcrEngine } from '../../src/main/ingestion/ocr'
import { openPdf } from '../../src/main/ingestion/pdf'
import { openPptx } from '../../src/main/ingestion/pptx'
import { IngestionRepo } from '../../src/main/ingestion/repo'
import { IngestionRunner, type RunnerDeps } from '../../src/main/ingestion/runner'
import { searchPassages } from '../../src/main/ingestion/search'
import type { DocumentSource } from '../../src/main/ingestion/types'
import { openDatabase, SessionStore } from '../../src/main/storage'
import { createFakeEmbedder } from './fakes/fakeEmbedder'
import { fixture, must } from './helpers'

let workDir: string
let db: Database.Database
let repo: IngestionRepo
let sessionId: number
let ocr: OcrEngine

/** Counts how often each page of each file is read. */
const reads = new Map<string, number>()

function openCounting(kind: 'pdf' | 'pptx', path: string, afterRead?: () => void): Promise<DocumentSource> {
  return (kind === 'pdf' ? openPdf(path) : openPptx(path)).then((source) => ({
    pageCount: source.pageCount,
    pageLabels: () => source.pageLabels(),
    outline: () => source.outline(),
    renderPage: (i, dpi) => source.renderPage(i, dpi),
    close: () => source.close(),
    readPage: async (i) => {
      const key = `${path}#${i}`
      reads.set(key, (reads.get(key) ?? 0) + 1)
      const content = await source.readPage(i)
      afterRead?.()
      return content
    }
  }))
}

function makeRunner(overrides: Partial<RunnerDeps> = {}, embedder: Embedder | null = createFakeEmbedder()): IngestionRunner {
  return new IngestionRunner({
    repo,
    materialsDir: join(workDir, 'materials'),
    openDocument: (kind, path) => openCounting(kind, path),
    ocr,
    embedder: () => embedder,
    onProgress: () => {},
    ...overrides
  })
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'feynmind-runner-'))
  db = openDatabase(join(workDir, 'feynmind.db'))
  repo = new IngestionRepo(db)
  sessionId = new SessionStore(db).current().id
  ocr = createTesseractOcr()
  reads.clear()
})

afterEach(async () => {
  await ocr.close()
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

const ALL_FIXTURES = [
  'openstax-precalculus-text.pdf',
  'openstax-precalculus-scanned.pdf',
  'openstax-precalculus-math-figures.pdf',
  'vectors-dot-product.pptx'
].map(fixture)

describe('importing files', () => {
  it('adds each file once, identified by content, and rejects unsupported files', async () => {
    const renamed = join(workDir, 'same-content-new-name.pdf')
    copyFileSync(fixture('openstax-precalculus-text.pdf'), renamed)
    const first = await importFiles([fixture('openstax-precalculus-text.pdf'), renamed, fixture('README.md')], sessionId, repo, join(workDir, 'materials'))
    expect(first.added).toEqual(['openstax-precalculus-text.pdf'])
    expect(first.duplicates).toEqual(['same-content-new-name.pdf'])
    expect(first.rejected).toEqual([{ name: 'README.md', reason: 'Only PDF and PowerPoint (.pptx) files can be added.' }])

    const again = await importFiles([fixture('openstax-precalculus-text.pdf')], sessionId, repo, join(workDir, 'materials'))
    expect(again).toEqual({ added: [], duplicates: ['openstax-precalculus-text.pdf'], rejected: [] })
    // Stored once, under its hash.
    expect(readdirSync(join(workDir, 'materials'))).toEqual(['7193f28f56fe922c1b4de0a2668b719eb634851735ab57d6035ca52539f4dc2c.pdf'])
  })

  it('rejects a file whose content does not match its extension', async () => {
    const fake = join(workDir, 'not-really.pdf')
    copyFileSync(fixture('vectors-dot-product.pptx'), fake)
    const result = await importFiles([fake], sessionId, repo, join(workDir, 'materials'))
    expect(result.rejected).toEqual([{ name: 'not-really.pdf', reason: 'This file is not a PDF.' }])
  })
})

describe('the ingestion queue', () => {
  it('reads, recognizes, flags, chunks and embeds every file, then finds passages with page numbers', async () => {
    await importFiles(ALL_FIXTURES, sessionId, repo, join(workDir, 'materials'))
    const embedder = createFakeEmbedder()
    await makeRunner({}, embedder).run()

    const summaries = repo.listMaterials(sessionId, true)
    expect(summaries.map((m) => [m.name, m.status, m.pageCount, m.pagesDone, m.pagesFailed])).toEqual([
      ['openstax-precalculus-text.pdf', 'done', 6, 6, 0],
      ['openstax-precalculus-scanned.pdf', 'done', 2, 2, 0],
      ['openstax-precalculus-math-figures.pdf', 'done', 2, 2, 0],
      ['vectors-dot-product.pptx', 'done', 4, 4, 0]
    ])
    const [text, scanned, mathFigures, deck] = summaries.map((m) => must(m))
    expect(scanned?.pagesOcr).toBe(2)
    expect(mathFigures?.pagesMathHeavy).toBe(2)
    expect(mathFigures?.pagesFigureHeavy).toBe(1)
    expect(deck?.pagesFigureHeavy).toBe(1)
    for (const m of summaries) {
      expect(m.chunkCount).toBeGreaterThan(0)
      expect(m.chunksEmbedded).toBe(m.chunkCount)
      expect(m.stage).toBe('done')
    }
    expect(text?.timings.extractMs).toBeGreaterThan(0)
    expect(scanned?.timings.ocrMs).toBeGreaterThan(0)
    expect(embedder.passagesEmbedded).toBe(summaries.reduce((n, m) => n + m.chunkCount, 0))

    // Every chunk records its file, section and page range.
    const sections = db.prepare("SELECT chapter, section, start_page AS startPage FROM sections WHERE material_id = 1 ORDER BY ordinal").all()
    expect(sections).toEqual([
      { chapter: 'Chapter 1. Functions', section: null, startPage: 1 },
      { chapter: 'Chapter 1. Functions', section: '1.1. Functions and Function Notation', startPage: 2 },
      { chapter: 'Chapter 1. Functions', section: '1.2. Domain and Range', startPage: 5 }
    ])

    const horror = await searchPassages(repo, sessionId, 'horror movies ticket sales', embedder)
    expect(horror.mode).toBe('hybrid')
    const top = must(horror.results[0], 'a result')
    expect(top).toMatchObject({ fileName: 'openstax-precalculus-text.pdf', section: '1.2. Domain and Range', matchedBy: { keyword: true, vector: true } })
    // Printed page numbers come from the PDF's page labels: PDF page 5 is printed page 22.
    expect(top.pageStart).toEqual({ index: 5, label: '22' })

    const notes = await searchPassages(repo, sessionId, 'students forget to add the products', embedder)
    expect(notes.results[0]).toMatchObject({ fileName: 'vectors-dot-product.pptx', section: 'Computing the dot product', pageStart: { index: 2, label: null } })

    // Text recognized from the scanned copy is searchable too.
    const ocrHit = await searchPassages(repo, sessionId, 'jetliner altitude', embedder)
    expect(ocrHit.results.map((r) => r.fileName)).toContain('openstax-precalculus-scanned.pdf')
  }, 120_000)

  it('continues after a stop without reading any finished page again', async () => {
    await importFiles(ALL_FIXTURES, sessionId, repo, join(workDir, 'materials'))
    let pagesRead = 0
    let first: IngestionRunner | null = null
    first = makeRunner({
      openDocument: (kind, path) =>
        openCounting(kind, path, () => {
          // Stop partway through the second file (the scanned one).
          if (++pagesRead === 7) void first?.stop()
        })
    })
    await first.run()
    const midway = repo.listMaterials(sessionId, true)
    expect(midway[0]?.status).toBe('done')
    expect(midway[1]?.pagesDone).toBe(1)
    expect(midway[2]?.status).toBe('queued')

    // A fresh runner (as after reopening the app) on the same database.
    await makeRunner().run()
    const after = repo.listMaterials(sessionId, true)
    expect(after.every((m) => m.status === 'done')).toBe(true)
    expect(after.reduce((n, m) => n + m.pagesDone, 0)).toBe(14)
    // No page was read twice.
    expect([...reads.values()].every((n) => n === 1)).toBe(true)
    expect(reads.size).toBe(14)

    // The result is the same as an uninterrupted run would give.
    const sections = db.prepare<[], { n: number }>('SELECT count(*) AS n FROM sections').get()?.n
    const chunks = db.prepare<[], { n: number }>('SELECT count(*) AS n FROM chunks').get()?.n
    const vectors = db.prepare<[], { n: number }>('SELECT count(*) AS n FROM chunk_vectors').get()?.n
    expect(vectors).toBe(chunks)
    expect(sections).toBeGreaterThanOrEqual(4)
  }, 120_000)

  it('keeps keyword search working while the embedding model is unavailable, then catches up in file order', async () => {
    await importFiles([fixture('openstax-precalculus-text.pdf'), fixture('vectors-dot-product.pptx')], sessionId, repo, join(workDir, 'materials'))
    let embedder: Embedder | null = null
    const runner = makeRunner({ embedder: () => embedder })
    await runner.run()
    const waiting = repo.listMaterials(sessionId, false)
    expect(waiting.map((m) => [m.status, m.stage, m.chunksEmbedded])).toEqual([
      ['processing', 'waiting-for-model', 0],
      ['processing', 'waiting-for-model', 0]
    ])
    const keywordOnly = await searchPassages(repo, sessionId, 'scary movie', null)
    expect(keywordOnly.mode).toBe('keyword')
    expect(keywordOnly.results[0]?.section).toBe('1.2. Domain and Range')

    // Before each embedding batch, record how far each file has got.
    const progress: [number, number][] = []
    const counts = db.prepare<[], { m: number; n: number }>('SELECT material_id AS m, sum(embedded) AS n FROM chunks GROUP BY material_id ORDER BY material_id')
    const fake = createFakeEmbedder()
    embedder = {
      ...fake,
      embedPassages: (texts) => {
        const [first, second] = counts.all()
        progress.push([first?.n ?? 0, second?.n ?? 0])
        return fake.embedPassages(texts)
      }
    }
    await makeRunner({ embedder: () => embedder }).run()
    expect(repo.listMaterials(sessionId, true).map((m) => m.status)).toEqual(['done', 'done'])
    // The second file's chunks are only embedded once all of the first file's are.
    const firstTotal = repo.summary(1, true)?.chunkCount ?? 0
    for (const [first, second] of progress) {
      if (second > 0) expect(first).toBe(firstTotal)
    }
  }, 120_000)

  it('marks unreadable files as failed and moves on', async () => {
    await importFiles([fixture('openstax-precalculus-text.pdf'), fixture('vectors-dot-product.pptx')], sessionId, repo, join(workDir, 'materials'))
    await makeRunner({
      openDocument: (kind, path) => (kind === 'pdf' ? Promise.reject(new Error('Broken file.')) : openCounting(kind, path))
    }).run()
    const [pdf, deck] = repo.listMaterials(sessionId, true)
    expect(pdf).toMatchObject({ status: 'failed', stage: 'failed', error: 'Broken file.' })
    expect(deck).toMatchObject({ status: 'done' })
  }, 60_000)

  it('records a page that cannot be read and keeps going', async () => {
    await importFiles([fixture('openstax-precalculus-text.pdf')], sessionId, repo, join(workDir, 'materials'))
    await makeRunner({
      openDocument: async (kind, path) => {
        const source = await openCounting(kind, path)
        return { ...source, readPage: (i) => (i === 3 ? Promise.reject(new Error('Bad page data.')) : source.readPage(i)) }
      }
    }).run()
    const [m] = repo.listMaterials(sessionId, true)
    expect(m).toMatchObject({ status: 'done', pagesDone: 6, pagesFailed: 1 })
    expect(repo.pageIssues(1).find((p) => p.pageIndex === 3)).toMatchObject({ failed: true, error: 'Bad page data.', pageLabel: '3' })
  }, 60_000)
})
