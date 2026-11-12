import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createGeminiAdapter, PREFERRED_DEFAULT_MODELS } from '../../src/main/providers'

// Real calls against Gemini. Opt-in only: `npm run test:live` sets FEYNMIND_LIVE=1.
// Makes exactly two calls: one model listing and one short generation on the cheapest model.
// The key is read from .env.local or GEMINI_API_KEY and is never printed or used in an assertion.

function readKey(): string | null {
  if (process.env['GEMINI_API_KEY']) return process.env['GEMINI_API_KEY']
  try {
    return parseEnv(readFileSync('.env.local', 'utf8'))['GEMINI_API_KEY']?.trim() || null
  } catch {
    return null
  }
}

const live = process.env['FEYNMIND_LIVE'] === '1'
const apiKey = live ? readKey() : null

describe.runIf(live)('Gemini (live)', () => {
  it('lists models and gets a reply from the cheapest one', async () => {
    if (!apiKey) throw new Error('No GEMINI_API_KEY in the environment or .env.local')
    const adapter = createGeminiAdapter({ apiKey })

    const models = await adapter.listModels()
    const ids = models.map((m) => m.id)
    console.log(`Listed ${ids.length} text models, e.g. ${ids.slice(0, 8).join(', ')}`)
    expect(ids.length).toBeGreaterThan(0)

    const modelId = PREFERRED_DEFAULT_MODELS.find((id) => ids.includes(id))
    if (!modelId) throw new Error('None of the preferred cheap models is available for this key')

    const reply = await adapter.generateText({ modelId, prompt: 'Reply with the single word: pong' })
    console.log(`${modelId} replied: ${reply.trim()}`)
    expect(reply.trim().length).toBeGreaterThan(0)
  }, 60_000)
})
