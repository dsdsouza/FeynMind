import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
    environment: 'node',
    // PDF reading and text recognition run in parallel test files; under load a single file can
    // take longer than Vitest's 5 s default even though nothing is wrong.
    testTimeout: 20_000,
    restoreMocks: true
  }
})
