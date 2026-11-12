// Runs the real ingestion pipeline (text extraction, OCR, chunking, local embeddings) on files you
// choose, with a throwaway database, and prints how long each stage took. No model API calls; the
// embedding model is downloaded once into a cache folder if it is not there yet.
//
// Usage: npm run bench:ingest -- <file.pdf|file.pptx> [...] [--queries questions.json]
//   questions.json is a JSON array of question strings; the top 3 passages for each are printed.
//   FEYNMIND_MODEL_CACHE sets the model cache folder (default: <temp>/feynmind-model-cache).
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const queriesAt = args.indexOf('--queries')
const queries = queriesAt === -1 ? undefined : resolve(args[queriesAt + 1] ?? '')
const files = args.filter((_, i) => queriesAt === -1 || (i !== queriesAt && i !== queriesAt + 1)).map((f) => resolve(f))
if (files.length === 0) {
  console.error('Usage: npm run bench:ingest -- <file> [<file> ...] [--queries questions.json]')
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  ['scripts/run-vitest.mjs', 'run', '--config', 'vitest.bench.config.mts', '--silent=false', '--reporter=dot'],
  {
    stdio: 'inherit',
    env: { ...process.env, FEYNMIND_BENCH_FILES: files.join('\n'), ...(queries ? { FEYNMIND_BENCH_QUERIES: queries } : {}) }
  }
)
process.exit(result.status ?? 1)
