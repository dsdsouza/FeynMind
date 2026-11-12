import { defineConfig } from 'vitest/config'

// Live tests make real provider calls and are excluded from `npm test`.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    environment: 'node'
  }
})
