import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { createBgeEmbedder } from '../../src/main/ingestion/embedder'
import { importFiles } from '../../src/main/ingestion/importer'
import { BGE_SMALL_EN, ensureModel } from '../../src/main/ingestion/modelStore'
import { createTesseractOcr } from '../../src/main/ingestion/ocr'
import { openPdf } from '../../src/main/ingestion/pdf'
import { openPptx } from '../../src/main/ingestion/pptx'
import { rechunkSection, sectionsTouching } from '../../src/main/ingestion/rechunk'
import { IngestionRepo } from '../../src/main/ingestion/repo'
import { IngestionRunner } from '../../src/main/ingestion/runner'
import { searchPassages } from '../../src/main/ingestion/search'
import { MATCH_END, MATCH_START, type PageRef, type SearchResult } from '../../src/shared/ingestion'
import { openDatabase, SessionStore } from '../../src/main/storage'

// Runs the real ingestion pipeline on files you choose and reports how long each stage took.
// Started by scripts/bench-ingest.mjs; see that file for usage. Uses a throwaway database and
// never copies the files anywhere but a temporary folder that is deleted afterwards.

const files = (process.env['FEYNMIND_BENCH_FILES'] ?? '').split('\n').filter(Boolean)
const queriesFile = process.env['FEYNMIND_BENCH_QUERIES']
const transcriptsDb = process.env['FEYNMIND_BENCH_TRANSCRIPTS']
const cacheDir = process.env['FEYNMIND_MODEL_CACHE'] ?? join(tmpdir(), 'feynmind-model-cache')

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

it('ingests and searches', async () => {
  if (files.length === 0) throw new Error('No files given. Run: npm run bench:ingest -- <file> [<file> ...]')
  const workDir = mkdtempSync(join(tmpdir(), 'feynmind-bench-'))
  const db = openDatabase(join(workDir, 'bench.db'))
  const ocr = createTesseractOcr()
  try {
    const repo = new IngestionRepo(db)
    const sessionId = new SessionStore(db).current().id
    const modelDir = await ensureModel(cacheDir, BGE_SMALL_EN, { fetch: (url, init) => fetch(url, init) })
    const embedder = await createBgeEmbedder(modelDir, BGE_SMALL_EN.id)

    const imported = await importFiles(files, sessionId, repo, join(workDir, 'materials'))
    console.log('Imported:', imported)
    const started = performance.now()
    let lastReport = 0
    const runner = new IngestionRunner({
      repo,
      materialsDir: join(workDir, 'materials'),
      openDocument: (kind, path) => (kind === 'pdf' ? openPdf(path) : openPptx(path)),
      ocr,
      embedder: () => embedder,
      onProgress: (id) => {
        if (performance.now() - lastReport < 15_000) return
        lastReport = performance.now()
        const m = repo.summary(id, true)
        if (m) console.log(`  ${seconds(performance.now() - started)}: ${m.name} pages ${m.pagesDone}/${m.pageCount ?? '?'}, chunks embedded ${m.chunksEmbedded}/${m.chunkCount}`)
      }
    })
    await runner.run()
    const wall = performance.now() - started

    for (const m of repo.listMaterials(sessionId, true)) {
      console.log(`\n${m.name}: ${m.status}${m.error ? ` (${m.error})` : ''}`)
      console.log(`  pages ${m.pagesDone}/${m.pageCount}, failed ${m.pagesFailed}, recognized (OCR) ${m.pagesOcr}, math-heavy ${m.pagesMathHeavy}, figure-heavy ${m.pagesFigureHeavy}`)
      console.log(`  chunks ${m.chunkCount}, embedded ${m.chunksEmbedded}`)
      console.log(`  extract ${seconds(m.timings.extractMs)}, OCR ${seconds(m.timings.ocrMs)}, embed ${seconds(m.timings.embedMs)}`)
      const labelled = db.prepare<[number], { n: number }>('SELECT count(*) AS n FROM pages WHERE material_id = ? AND page_label IS NOT NULL').get(m.id)?.n
      const sections = db.prepare<[number], { n: number }>('SELECT count(*) AS n FROM sections WHERE material_id = ?').get(m.id)?.n
      console.log(`  pages with a printed page number: ${labelled}, sections: ${sections}`)
    }
    console.log(`\nTotal wall time: ${seconds(wall)}`)

    if (transcriptsDb) {
      const copied = copyTranscripts(transcriptsDb, db, repo, sessionId)
      console.log(`\nTranscriptions copied from ${transcriptsDb}: ${copied.pages} pages; re-chunked ${copied.sections} sections`)
      await runner.run()
    }

    if (queriesFile) {
      const failures = await runQueries(loadQueries(queriesFile), async (query) => (await searchPassages(repo, sessionId, query, embedder)).results)
      if (failures > 0) throw new Error(`${failures} search check(s) failed; see the lines marked FAIL above.`)
    }
    await embedder.close()
  } finally {
    await ocr.close()
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
}, 3 * 60 * 60 * 1000)

/**
 * Copies vision transcriptions for the same files (matched by SHA-256) from an app database,
 * opened read-only, then re-chunks the sections they touch. The source database is never changed.
 */
function copyTranscripts(sourcePath: string, db: Database.Database, repo: IngestionRepo, sessionId: number): { pages: number; sections: number } {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
  let pages = 0
  let sections = 0
  try {
    const rows = source.prepare<[string], { pageIndex: number; blocks: string; text: string; cacheKey: string }>(
      `SELECT t.page_index AS pageIndex, t.blocks, t.text, t.cache_key AS cacheKey FROM page_transcripts t
       JOIN materials m ON m.id = t.material_id WHERE m.sha256 = ? ORDER BY t.page_index`
    )
    const insert = db.prepare('INSERT OR REPLACE INTO page_transcripts (session_id, material_id, page_index, blocks, text, cache_key) VALUES (?, ?, ?, ?, ?, ?)')
    for (const m of repo.listMaterials(sessionId, true)) {
      const sha = repo.getMaterial(m.id)?.sha256 ?? ''
      const found = rows.all(sha)
      for (const r of found) insert.run(sessionId, m.id, r.pageIndex, r.blocks, r.text, r.cacheKey)
      pages += found.length
      for (const id of sectionsTouching(repo, m.id, found.map((r) => r.pageIndex))) {
        rechunkSection(repo, id)
        sections++
      }
    }
  } finally {
    source.close()
  }
  return { pages, sections }
}

/**
 * A search to try. `page` (a 1-based PDF page) or `pages` (an inclusive range) is where the first
 * result's matching sentences must be; `section` is the section it must come from. Without any of
 * them, the top results are only printed.
 */
interface QueryCheck {
  query: string
  page?: number
  pages?: [number, number]
  section?: string
  note?: string
}

/** Reads a JSON array of question strings or QueryChecks, or an object with such an array under `queries`. */
function loadQueries(file: string): QueryCheck[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  const list = Array.isArray(raw) ? raw : (raw as { queries?: unknown }).queries
  if (!Array.isArray(list)) throw new Error(`${file}: expected a JSON array of questions, or an object with a "queries" array`)
  return list.map((q) => (typeof q === 'string' ? { query: q } : (q as QueryCheck)))
}

const pdfPages = (start: PageRef, end: PageRef): string => `PDF ${start.index}${end.index !== start.index ? `–${end.index}` : ''}`
const printedPages = (start: PageRef, end: PageRef): string =>
  start.label === null ? '' : `p. ${start.label}${end.label && end.label !== start.label ? `–${end.label}` : ''} `
const plain = (text: string): string => text.replaceAll(MATCH_START, '').replaceAll(MATCH_END, '').replace(/\s+/g, ' ')

/** Whether a result is from the expected section, with its matching sentences inside the expected pages. */
function meets(r: SearchResult, check: QueryCheck): boolean {
  const [from, to] = check.pages ?? (check.page !== undefined ? [check.page, check.page] : [-Infinity, Infinity])
  const onPages = r.matchStart.index <= to && r.matchEnd.index >= from
  return onPages && (check.section === undefined || r.section === check.section)
}

/** Prints the top 3 results for each query and checks the first against any expectation. Returns the number of failures. */
async function runQueries(checks: QueryCheck[], search: (query: string) => Promise<SearchResult[]>): Promise<number> {
  let failures = 0
  let checked = 0
  for (const check of checks) {
    const started = performance.now()
    const results = await search(check.query)
    console.log(`\nQ: ${check.query}  (${Math.round(performance.now() - started)} ms)`)
    for (const r of results.slice(0, 3)) {
      const match = pdfPages(r.matchStart, r.matchEnd)
      const passage = pdfPages(r.pageStart, r.pageEnd) === match ? '' : `, passage ${pdfPages(r.pageStart, r.pageEnd)}`
      console.log(`  - ${r.section ?? r.chapter ?? '(no section)'} | ${printedPages(r.matchStart, r.matchEnd)}(${match}${passage}) [${r.focusKind}]`)
      console.log(`      ${plain(r.context.focus).slice(0, 160)}`)
    }
    if (check.page === undefined && check.pages === undefined && check.section === undefined) continue
    checked++
    const where = check.page !== undefined ? `PDF ${check.page}` : check.pages ? `PDF ${check.pages[0]}–${check.pages[1]}` : undefined
    const expected = [check.section, where].filter(Boolean).join(', ')
    const rank = results.findIndex((r) => meets(r, check)) + 1
    if (rank === 1) {
      console.log(`  PASS: first result is ${expected}`)
    } else {
      failures++
      console.log(`  FAIL: expected ${expected} first; ${rank === 0 ? `not in the top ${results.length}` : `found at rank ${rank}`}`)
    }
  }
  if (checked > 0) console.log(`\nSearch checks: ${checked - failures} of ${checked} passed`)
  return failures
}
