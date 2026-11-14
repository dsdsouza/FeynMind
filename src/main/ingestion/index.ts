// The ingestion module: file import, text extraction, text recognition, chunking, embeddings,
// search and the resumable job queue. Other modules use only what is exported here.
export { IngestionService, type IngestionServiceOptions } from './service'
export { IngestionReader, type ChunkText, type SectionContent } from './reader'
export type { PageForVision } from './repo'
export type { TranscriptBlock } from './transcripts'
export type { TextLine } from './types'
export type { Embedder } from './embedder'
export { ensureModel, isModelReady, modelFolder, totalSize, type DownloadProgress, type FetchFn, type ModelSpec } from './modelStore'
