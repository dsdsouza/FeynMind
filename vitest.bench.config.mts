import { defineConfig } from 'vitest/config'

// The ingestion benchmark (npm run bench:ingest). Excluded from `npm test`.
export default defineConfig({
  test: {
    include: ['tests/bench/**/*.bench.test.ts'],
    environment: 'node'
  }
})
