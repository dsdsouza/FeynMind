// The ingestion module: file import, text extraction, text recognition, chunking, embeddings,
// search and the resumable job queue. Other modules use only what is exported here.
export { IngestionService, type IngestionServiceOptions } from './service'
export type { Embedder } from './embedder'
