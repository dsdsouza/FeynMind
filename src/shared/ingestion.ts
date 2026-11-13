// Types for course sessions, imported materials and search, shared by the main process and the renderer.

export interface Session {
  id: number
  name: string
  createdAt: string
}

export type MaterialKind = 'pdf' | 'pptx'
export type MaterialStatus = 'queued' | 'processing' | 'done' | 'failed'

/**
 * What the worker is doing with a material right now.
 * `waiting-for-model`: all pages are read and keyword search works, but the embedding model is
 * not available yet (still downloading, or the download failed).
 */
export type MaterialStage = 'queued' | 'reading' | 'embedding' | 'waiting-for-model' | 'done' | 'failed'

export interface MaterialSummary {
  id: number
  sessionId: number
  name: string
  kind: MaterialKind
  byteSize: number
  status: MaterialStatus
  stage: MaterialStage
  error: string | null
  pageCount: number | null
  pagesDone: number
  pagesFailed: number
  pagesOcr: number
  pagesMathHeavy: number
  pagesFigureHeavy: number
  chunkCount: number
  chunksEmbedded: number
  /** Time spent on each stage so far, in milliseconds. */
  timings: { extractMs: number; ocrMs: number; embedMs: number }
  addedAt: string
  startedAt: string | null
  finishedAt: string | null
}

/** A page that failed, needed text recognition, or was flagged for a vision model. */
export interface PageIssue {
  pageIndex: number
  pageLabel: string | null
  failed: boolean
  error: string | null
  ocr: boolean
  ocrConfidence: number | null
  mathHeavy: boolean
  figureHeavy: boolean
}

export interface AddMaterialsResult {
  added: string[]
  /** Files already in this session (same content), by file name. */
  duplicates: string[]
  rejected: { name: string; reason: string }[]
}

/** A page position: `index` is 1-based within the file; `label` is the printed page number, if known. */
export interface PageRef {
  index: number
  label: string | null
}

export interface SearchResult {
  chunkId: number
  materialId: number
  fileName: string
  chapter: string | null
  section: string | null
  /** The whole passage's page range. */
  pageStart: PageRef
  pageEnd: PageRef
  /** The pages holding the sentences the result opens on; the passage's range if they could not be placed. */
  matchStart: PageRef
  matchEnd: PageRef
  /**
   * The passage split around the sentences to open on (`focus`). Matched query words, and a run of
   * the query's exact wording, are wrapped in MATCH_START and MATCH_END in all three parts.
   */
  context: { before: string; focus: string; after: string }
  /**
   * What the focus sentences are: 'wording' repeats the query's wording, 'words' holds the most
   * query words, 'none' shares no words with the query (found by meaning) and is the passage start.
   */
  focusKind: 'wording' | 'words' | 'none'
  matchedBy: { keyword: boolean; vector: boolean; wording: boolean }
}

export const MATCH_START = '\u{E000}'
export const MATCH_END = '\u{E001}'

export interface SearchResponse {
  results: SearchResult[]
  /** 'keyword' when the embedding model is not available yet. */
  mode: 'hybrid' | 'keyword'
}

/** The background import process: whether it is running, and its last unexpected exit in this app session. */
export interface WorkerStatus {
  state: 'running' | 'restarting'
  lastExit: {
    /** The worker's exit code. */
    code: number
    /** ISO time of the exit. */
    at: string
    /** Unexpected exits so far in this app session. */
    count: number
  } | null
  /** Where unexpected exits are recorded. */
  logPath: string
}

export interface IngestionProgress {
  material: MaterialSummary
}

export type ModelState = 'missing' | 'downloading' | 'ready' | 'failed' | 'disabled'

export interface ModelStatus {
  state: ModelState
  name: string
  receivedBytes: number
  totalBytes: number
  error: string | null
}
