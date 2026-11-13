import { utilityProcess, type UtilityProcess } from 'electron'
import type Database from 'better-sqlite3'
import type { AddMaterialsResult, MaterialSummary, ModelStatus, PageIssue, SearchResponse, WorkerStatus } from '../../shared/ingestion'
import { BGE_SMALL_EN, totalSize } from './modelStore'
import type { MainToWorker, WorkerInit, WorkerRequests, WorkerRequestType, WorkerToMain } from './protocol'
import { IngestionReader } from './reader'
import { IngestionRepo } from './repo'

const MAX_QUERY_LENGTH = 1000
/** Search and page previews should answer quickly; imports can take as long as hashing big files takes. */
const REQUEST_TIMEOUT_MS: Partial<Record<WorkerRequestType, number>> = { search: 60_000, renderPage: 60_000, renderForVision: 60_000 }
const RESTART_DELAYS_MS = [1_000, 5_000, 30_000]

export interface IngestionServiceOptions {
  /** The main process's own database connection, used for reads. */
  db: Database.Database
  workerPath: string
  init: Omit<WorkerInit, 'type'>
  onProgress: (summary: MaterialSummary) => void
  onModelStatus: (status: ModelStatus) => void
  onWorkerStatus: (status: WorkerStatus) => void
  /** Records an unexpected worker exit in the exit log. */
  recordExit: (message: string) => void
  /** The exit log's path, shown to the user after a restart. */
  exitLogPath: string
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

/**
 * The ingestion module's public service, used by the main process. Heavy work runs in a separate
 * utility process; this class starts it, restarts it if it crashes (it resumes from the database),
 * forwards requests and reads progress from the database.
 */
export class IngestionService {
  private worker: UtilityProcess | null = null
  private readonly repo: IngestionRepo
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private restarts = 0
  private stopping = false
  private workerStatus: WorkerStatus
  private modelStatus: ModelStatus = { state: 'missing', name: BGE_SMALL_EN.name, receivedBytes: 0, totalBytes: totalSize(BGE_SMALL_EN), error: null }

  constructor(private readonly options: IngestionServiceOptions) {
    this.repo = new IngestionRepo(options.db)
    this.workerStatus = { state: 'running', lastExit: null, logPath: options.exitLogPath }
  }

  start(): void {
    const worker = utilityProcess.fork(this.options.workerPath, [], { serviceName: 'FeynMind ingestion', stdio: 'pipe' })
    this.worker = worker
    worker.stdout?.on('data', (data: Buffer) => console.log(`[ingestion] ${String(data).trimEnd()}`))
    worker.stderr?.on('data', (data: Buffer) => console.error(`[ingestion] ${String(data).trimEnd()}`))
    worker.on('message', (message: WorkerToMain) => this.handle(message))
    worker.on('exit', (code) => this.onExit(worker, code))
    this.post({ type: 'init', ...this.options.init })
    if (this.workerStatus.state !== 'running') this.setWorkerStatus({ ...this.workerStatus, state: 'running' })
  }

  /** Asks the worker to finish its current page and exit; kills it if it does not within `timeoutMs`. */
  async stop(timeoutMs = 3_000): Promise<void> {
    this.stopping = true
    const worker = this.worker
    if (!worker) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        worker.kill()
        resolve()
      }, timeoutMs)
      worker.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      this.post({ type: 'shutdown' })
    })
  }

  listMaterials(sessionId: number): MaterialSummary[] {
    return this.repo.listMaterials(sessionId, this.modelStatus.state === 'ready')
  }

  pageIssues(materialId: number): PageIssue[] {
    return this.repo.pageIssues(materialId)
  }

  getWorkerStatus(): WorkerStatus {
    return this.workerStatus
  }

  getModelStatus(): ModelStatus {
    return this.modelStatus
  }

  addFiles(sessionId: number, paths: string[]): Promise<AddMaterialsResult> {
    return this.request('import', { sessionId, paths })
  }

  search(sessionId: number, query: string): Promise<SearchResponse> {
    if (query.length > MAX_QUERY_LENGTH) throw new Error(`Keep the search under ${MAX_QUERY_LENGTH} characters.`)
    return this.request('search', { sessionId, query })
  }

  renderPage(materialId: number, pageIndex: number): Promise<string | null> {
    return this.request('renderPage', { materialId, pageIndex })
  }

  retryModel(): Promise<ModelStatus> {
    return this.request('retryModel', {})
  }

  /** Reads a PDF's text on this machine, without importing it (for a syllabus). */
  readText(path: string): Promise<{ name: string; sha256: string; text: string }> {
    return this.request('readText', { path })
  }

  /** A page as PNG bytes for a vision model. */
  async renderForVision(materialId: number, pageIndex: number): Promise<Uint8Array> {
    return Buffer.from(await this.request('renderForVision', { materialId, pageIndex }), 'base64')
  }

  rechunkSections(sectionIds: number[]): Promise<{ chunks: number }> {
    return this.request('rechunkSections', { sectionIds })
  }

  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    return (await this.request('embedTexts', { texts })).map((v) => Float32Array.from(v))
  }

  /** Read access to sections and pages, for the knowledge module. */
  get reader(): IngestionReader {
    return new IngestionReader(this.repo)
  }

  private request<K extends WorkerRequestType>(kind: K, payload: WorkerRequests[K]['request']): Promise<WorkerRequests[K]['response']> {
    if (!this.worker) return Promise.reject(new Error('Ingestion is restarting. Try again in a moment.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = REQUEST_TIMEOUT_MS[kind]
      const timer = timeout
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new Error('Ingestion did not answer in time. Try again.'))
          }, timeout)
        : null
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.post({ type: 'request', id, kind, payload } as MainToWorker)
    })
  }

  private post(message: MainToWorker): void {
    this.worker?.postMessage(message)
  }

  private handle(message: WorkerToMain): void {
    switch (message.type) {
      case 'response': {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (pending.timer) clearTimeout(pending.timer)
        if (message.ok) pending.resolve(message.value)
        else pending.reject(new Error(message.error))
        return
      }
      case 'progress': {
        this.restarts = 0
        const summary = this.repo.summary(message.materialId, this.modelStatus.state === 'ready')
        if (summary) this.options.onProgress(summary)
        return
      }
      case 'model':
        this.modelStatus = message.status
        this.options.onModelStatus(message.status)
        return
      case 'log':
        if (message.level === 'error') console.error(`[ingestion] ${message.message}`)
        else console.log(`[ingestion] ${message.message}`)
    }
  }

  private onExit(worker: UtilityProcess, code: number): void {
    if (this.worker !== worker) return
    this.worker = null
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new Error('Ingestion stopped unexpectedly. It will continue where it left off.'))
      this.pending.delete(id)
    }
    if (this.stopping) return
    // The worker resumes from the database, so restarting it continues the import.
    const delay = RESTART_DELAYS_MS[Math.min(this.restarts, RESTART_DELAYS_MS.length - 1)] ?? 30_000
    this.restarts++
    const count = (this.workerStatus.lastExit?.count ?? 0) + 1
    const message = `Ingestion worker exited unexpectedly with code ${code}; restarting in ${delay / 1000} s (unexpected exit ${count} this session).`
    console.error(`[ingestion] ${message}`)
    this.options.recordExit(message)
    this.setWorkerStatus({ ...this.workerStatus, state: 'restarting', lastExit: { code, at: new Date().toISOString(), count } })
    setTimeout(() => {
      if (!this.stopping) this.start()
    }, delay)
  }

  private setWorkerStatus(status: WorkerStatus): void {
    this.workerStatus = status
    this.options.onWorkerStatus(status)
  }
}
