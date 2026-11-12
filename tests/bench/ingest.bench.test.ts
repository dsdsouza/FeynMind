import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { createBgeEmbedder } from '../../src/main/ingestion/embedder'
import { importFiles } from '../../src/main/ingestion/importer'
import { BGE_SMALL_EN, ensureModel } from '../../src/main/ingestion/modelStore'
import { createTesseractOcr } from '../../src/main/ingestion/ocr'
import { openPdf } from '../../src/main/ingestion/pdf'
import { openPptx } from '../../src/main/ingestion/pptx'
import { IngestionRepo } from '../../src/main/ingestion/repo'
import { IngestionRunner } from '../../src/main/ingestion/runner'
import { searchPassages } from '../../src/main/ingestion/search'
import { openDatabase, SessionStore } from '../../src/main/storage'

// Runs the real ingestion pipeline on files you choose and reports how long each stage took.
// Started by scripts/bench-ingest.mjs; see that file for usage. Uses a throwaway database and
// never copies the files anywhere but a temporary folder that is deleted afterwards.

const files = (process.env['FEYNMIND_BENCH_FILES'] ?? '').split('\n').filter(Boolean)
const queriesFile = process.env['FEYNMIND_BENCH_QUERIES']
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

    if (queriesFile) {
      const queries = JSON.parse(readFileSync(queriesFile, 'utf8')) as string[]
      for (const query of queries) {
        const t = performance.now()
        const response = await searchPassages(repo, sessionId, query, embedder, 3)
        console.log(`\nQ: ${query}  (${Math.round(performance.now() - t)} ms)`)
        for (const r of response.results) {
          const page = r.pageStart.label ? `p. ${r.pageStart.label}${r.pageEnd.label && r.pageEnd.label !== r.pageStart.label ? `–${r.pageEnd.label}` : ''}` : ''
          console.log(`  - ${r.section ?? r.chapter ?? '(no section)'} | ${page} (PDF ${r.pageStart.index}${r.pageEnd.index !== r.pageStart.index ? `–${r.pageEnd.index}` : ''})`)
        }
      }
    }
    await embedder.close()
  } finally {
    await ocr.close()
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
}, 3 * 60 * 60 * 1000)
