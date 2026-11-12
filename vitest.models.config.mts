import { defineConfig } from 'vitest/config'

// Model tests download the pinned local embedding model (once) and are excluded from `npm test`.
// They make no model API calls.
export default defineConfig({
  test: {
    include: ['tests/models/**/*.models.test.ts'],
    environment: 'node',
    testTimeout: 120_000
  }
})
