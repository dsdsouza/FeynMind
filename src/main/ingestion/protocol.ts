import type { AddMaterialsResult, ModelStatus, SearchResponse } from '../../shared/ingestion'

// Messages between the main process (service.ts) and the ingestion worker (worker.ts).

export interface WorkerInit {
  type: 'init'
  dbPath: string
  materialsDir: string
  modelsDir: string
  /** False in tests that must not reach the network: the model is used only if already on disk. */
  allowModelDownload: boolean
}

export interface WorkerRequests {
  import: { request: { sessionId: number; paths: string[] }; response: AddMaterialsResult }
  search: { request: { sessionId: number; query: string }; response: SearchResponse }
  /** A PNG as base64, or null when the page cannot be rendered (slides). */
  renderPage: { request: { materialId: number; pageIndex: number }; response: string | null }
  retryModel: { request: Record<string, never>; response: ModelStatus }
  /** Reads a document's text locally (with text recognition for scanned pages), without importing it. */
  readText: { request: { path: string }; response: { name: string; sha256: string; text: string } }
  /** A page rendered for a vision model, as base64 PNG. */
  renderForVision: { request: { materialId: number; pageIndex: number }; response: string }
  /** Rebuilds the chunks of these sections from their pages, using transcriptions where there are any. */
  rechunkSections: { request: { sectionIds: number[] }; response: { chunks: number } }
  /** Embeds short texts with the local model, for comparing concepts. */
  embedTexts: { request: { texts: string[] }; response: number[][] }
}

export type WorkerRequestType = keyof WorkerRequests

export type MainToWorker =
  | WorkerInit
  | { type: 'shutdown' }
  | { [K in WorkerRequestType]: { type: 'request'; id: number; kind: K; payload: WorkerRequests[K]['request'] } }[WorkerRequestType]

export type WorkerToMain =
  | { type: 'response'; id: number; ok: true; value: unknown }
  | { type: 'response'; id: number; ok: false; error: string }
  | { type: 'progress'; materialId: number }
  | { type: 'model'; status: ModelStatus }
  | { type: 'log'; level: 'info' | 'error'; message: string }
