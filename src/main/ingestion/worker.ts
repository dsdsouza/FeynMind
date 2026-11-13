// The ingestion worker: an Electron utility process started by service.ts. It owns ingestion
// writes to the database, the import queue, the embedding model and search, so none of this work
// can freeze the window. All of its state lives in the database; if it is stopped or crashes, a new
// worker continues where it left off.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type Database from 'better-sqlite3'
import type { ModelStatus } from '../../shared/ingestion'
import { openDatabase } from '../storage'
import { createBgeEmbedder, type Embedder } from './embedder'
import { importFiles } from './importer'
import { BGE_SMALL_EN, ensureModel, isModelReady, modelFolder, totalSize } from './modelStore'
import { createTesseractOcr } from './ocr'
import { analyzePage } from './pageAnalysis'
import { openPdf } from './pdf'
import { openPptx } from './pptx'
import type { MainToWorker, WorkerInit, WorkerRequests, WorkerRequestType, WorkerToMain } from './protocol'
import { rechunkSection } from './rechunk'
import { IngestionRepo } from './repo'
import { IngestionRunner, OCR_DPI } from './runner'
import { searchPassages } from './search'

/** Page previews for the materials screen are rendered at this resolution. */
const PREVIEW_DPI = 110
/**
 * Pages sent to a vision model. Gemini 3 charges a fixed 1120 tokens per image at high media
 * resolution whatever its size, so this only needs to be sharp enough for subscripts.
 */
const VISION_DPI = 150
/** A syllabus longer than this is not a syllabus; refuse rather than send a book to the model. */
const MAX_SYLLABUS_PAGES = 40
const PROGRESS_INTERVAL_MS = 250

const port = process.parentPort
const send = (message: WorkerToMain): void => port.postMessage(message)
const log = (level: 'info' | 'error', message: string): void => send({ type: 'log', level, message })

let state: {
  init: WorkerInit
  db: Database.Database
  repo: IngestionRepo
  runner: IngestionRunner
  ocr: ReturnType<typeof createTesseractOcr>
} | null = null

let embedder: Embedder | null = null
let modelStatus: ModelStatus = { state: 'missing', name: BGE_SMALL_EN.name, receivedBytes: 0, totalBytes: totalSize(BGE_SMALL_EN), error: null }
let modelLoading: Promise<void> | null = null

function setModelStatus(next: Partial<ModelStatus>): void {
  modelStatus = { ...modelStatus, ...next }
  send({ type: 'model', status: modelStatus })
}

/** Sends progress for a material at most every PROGRESS_INTERVAL_MS, always including the latest. */
const progressTimers = new Map<number, NodeJS.Timeout>()
function reportProgress(materialId: number): void {
  if (progressTimers.has(materialId)) return
  send({ type: 'progress', materialId })
  progressTimers.set(
    materialId,
    setTimeout(() => {
      progressTimers.delete(materialId)
      send({ type: 'progress', materialId })
    }, PROGRESS_INTERVAL_MS)
  )
}

/** Makes the embedding model available: from disk if it is there and intact, otherwise by downloading it once. */
function loadModel(): Promise<void> {
  if (!state || embedder || modelLoading) return modelLoading ?? Promise.resolve()
  const { modelsDir, allowModelDownload } = state.init
  modelLoading = (async () => {
    try {
      let lastSent = 0
      if (!(await isModelReady(modelsDir, BGE_SMALL_EN))) {
        if (!allowModelDownload) {
          setModelStatus({ state: 'disabled', error: 'Downloading the search model is turned off. Keyword search still works.' })
          return
        }
        setModelStatus({ state: 'downloading', receivedBytes: 0, error: null })
        await ensureModel(modelsDir, BGE_SMALL_EN, {
          fetch: (url, init) => fetch(url, init),
          onProgress: ({ receivedBytes, totalBytes }) => {
            if (Date.now() - lastSent < 200 && receivedBytes < totalBytes) return
            lastSent = Date.now()
            setModelStatus({ state: 'downloading', receivedBytes, totalBytes })
          }
        })
      }
      embedder = await createBgeEmbedder(modelFolder(modelsDir, BGE_SMALL_EN), BGE_SMALL_EN.id)
      setModelStatus({ state: 'ready', receivedBytes: modelStatus.totalBytes, error: null })
      void state?.runner.run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('error', `Search model unavailable: ${message}`)
      setModelStatus({ state: 'failed', error: message })
    } finally {
      modelLoading = null
    }
  })()
  return modelLoading
}

function start(init: WorkerInit): void {
  const db = openDatabase(init.dbPath, { migrate: false })
  const repo = new IngestionRepo(db)
  const ocr = createTesseractOcr()
  const runner = new IngestionRunner({
    repo,
    materialsDir: init.materialsDir,
    openDocument: (kind, path) => (kind === 'pdf' ? openPdf(path) : openPptx(path)),
    ocr,
    embedder: () => embedder,
    onProgress: reportProgress,
    onEmbedError: (error) => {
      const message = error instanceof Error ? error.message : String(error)
      log('error', `Embedding failed: ${message}`)
      void embedder?.close()
      embedder = null
      setModelStatus({ state: 'failed', error: message })
    }
  })
  state = { init, db, repo, runner, ocr }
  send({ type: 'model', status: modelStatus })
  // Load the model now only if there is something to embed; otherwise on the first import.
  if (db.prepare('SELECT 1 FROM materials LIMIT 1').get()) void loadModel()
  void runner.run()
}

const handlers: { [K in WorkerRequestType]: (payload: WorkerRequests[K]['request']) => Promise<WorkerRequests[K]['response']> } = {
  async import({ sessionId, paths }) {
    if (!state) throw new Error('The ingestion worker is not ready.')
    const result = await importFiles(paths, sessionId, state.repo, state.init.materialsDir)
    if (result.added.length > 0) {
      void loadModel()
      void state.runner.run()
    }
    return result
  },
  async search({ sessionId, query }) {
    if (!state) throw new Error('The ingestion worker is not ready.')
    return searchPassages(state.repo, sessionId, query, embedder)
  },
  async renderPage({ materialId, pageIndex }) {
    if (!state) throw new Error('The ingestion worker is not ready.')
    const material = state.repo.getMaterial(materialId)
    if (!material) throw new Error('That file is not in this session.')
    if (material.kind !== 'pdf') return null
    if (!Number.isInteger(pageIndex) || pageIndex < 1 || pageIndex > (material.pageCount ?? 0)) throw new Error('That page does not exist.')
    const doc = await openPdf(join(state.init.materialsDir, material.storedName))
    try {
      return (await doc.renderPage(pageIndex, PREVIEW_DPI))?.toString('base64') ?? null
    } finally {
      await doc.close()
    }
  },
  async readText({ path }) {
    if (!path.toLowerCase().endsWith('.pdf')) throw new Error('Choose a PDF, or paste the syllabus as text.')
    const bytes = await readFile(path)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const doc = await openPdf(path)
    const ocr = createTesseractOcr()
    try {
      if (doc.pageCount > MAX_SYLLABUS_PAGES) throw new Error(`That PDF has ${doc.pageCount} pages. A syllabus is expected to have at most ${MAX_SYLLABUS_PAGES}.`)
      const pages: string[] = []
      for (let i = 1; i <= doc.pageCount; i++) {
        const content = await doc.readPage(i)
        let lines = content.lines
        if (analyzePage(content).scanned) {
          const png = await doc.renderPage(i, OCR_DPI)
          if (png) lines = (await ocr.recognize(png, OCR_DPI / 72)).lines
        }
        pages.push(lines.map((l) => l.text).join('\n'))
      }
      const text = pages.join('\n\n').trim()
      if (text === '') throw new Error('No text could be read from that PDF.')
      return { name: basename(path), sha256, text }
    } finally {
      await doc.close()
      await ocr.close()
    }
  },
  async renderForVision({ materialId, pageIndex }) {
    if (!state) throw new Error('The ingestion worker is not ready.')
    const material = state.repo.getMaterial(materialId)
    if (!material) throw new Error('That file is not in this session.')
    if (material.kind !== 'pdf') throw new Error('Only PDF pages can be shown to a vision model.')
    const doc = await openPdf(join(state.init.materialsDir, material.storedName))
    try {
      const png = await doc.renderPage(pageIndex, VISION_DPI)
      if (!png) throw new Error(`Page ${pageIndex} could not be rendered.`)
      return png.toString('base64')
    } finally {
      await doc.close()
    }
  },
  async rechunkSections({ sectionIds }) {
    if (!state) throw new Error('The ingestion worker is not ready.')
    let chunks = 0
    for (const id of sectionIds) {
      chunks += rechunkSection(state.repo, id)
      const materialId = state.repo.getSection(id)?.materialId
      if (materialId !== undefined) reportProgress(materialId)
    }
    // Embed the new chunks in the background, as for an import.
    void loadModel()
    void state.runner.run()
    return { chunks }
  },
  async embedTexts({ texts }) {
    if (!embedder) {
      await loadModel()
      if (!embedder) throw new Error('The local search model is not available yet, so concepts cannot be compared. Check the model status on the Materials screen.')
    }
    const vectors = await embedder.embedPassages(texts)
    return vectors.map((v) => Array.from(v))
  },
  async retryModel() {
    if (modelStatus.state === 'failed' || modelStatus.state === 'missing') await loadModel()
    return modelStatus
  }
}

async function shutdown(): Promise<void> {
  if (state) {
    await state.runner.stop()
    await state.ocr.close()
    state.db.close()
  }
  await embedder?.close()
  process.exit(0)
}

port.on('message', (event: { data: MainToWorker }) => {
  const message = event.data
  if (message.type === 'init') {
    start(message)
    return
  }
  if (message.type === 'shutdown') {
    void shutdown()
    return
  }
  const handler = handlers[message.kind] as (payload: unknown) => Promise<unknown>
  handler(message.payload).then(
    (value) => send({ type: 'response', id: message.id, ok: true, value }),
    (error: unknown) => send({ type: 'response', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  )
})
