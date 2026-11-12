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
