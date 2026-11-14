// Runs the real ingestion pipeline (text extraction, OCR, chunking, local embeddings) on files you
// choose, with a throwaway database, and prints how long each stage took. No model API calls; the
// embedding model is downloaded once into a cache folder if it is not there yet.
//
// Usage: npm run bench:ingest -- <file.pdf|file.pptx> [...] [--queries questions.json ...] [--transcripts-from feynmind.db]
//   questions.json is a JSON array of question strings, or of checks such as
//   {"query": "...", "section": "2.5 Inverse Matrices", "page": 102} ("pages": [from, to] for a range),
//   or an object holding that array under "queries". The top 3 passages for each are printed; a
//   check fails unless the first result is from that section with its matching sentences on those
//   PDF pages, and any failure makes the command fail. See tests/bench/strang-regression.json.
//   --queries may be given more than once; the files are checked in order.
//   --transcripts-from copies the vision transcriptions of the same files (matched by content)
//   from an app database, read-only, re-chunks the affected sections and re-embeds them before the
//   queries run, so search is checked on transcribed pages without any model call. On Windows the
//   app's database is %APPDATA%\feynmind\feynmind.db.
//   FEYNMIND_MODEL_CACHE sets the model cache folder (default: <temp>/feynmind-model-cache).
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
/** Removes `--name value` from args and returns the value. */
function option(name) {
  const at = args.indexOf(name)
  if (at === -1) return undefined
  const value = args[at + 1]
  args.splice(at, 2)
  return value === undefined ? undefined : resolve(value)
}
const queries = []
for (let q = option('--queries'); q !== undefined; q = option('--queries')) queries.push(q)
const transcripts = option('--transcripts-from')
const files = args.map((f) => resolve(f))
if (files.length === 0) {
  console.error('Usage: npm run bench:ingest -- <file> [<file> ...] [--queries questions.json ...] [--transcripts-from feynmind.db]')
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  ['scripts/run-vitest.mjs', 'run', '--config', 'vitest.bench.config.mts', '--silent=false', '--reporter=dot'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      FEYNMIND_BENCH_FILES: files.join('\n'),
      ...(queries.length > 0 ? { FEYNMIND_BENCH_QUERIES: queries.join('\n') } : {}),
      ...(transcripts ? { FEYNMIND_BENCH_TRANSCRIPTS: transcripts } : {})
    }
  }
)
process.exit(result.status ?? 1)
