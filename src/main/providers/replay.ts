import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import type { AdapterFactory, GenerateRequest } from './types'

// A provider that answers from a file instead of the network, for end-to-end tests of the built
// app. It is used only when FEYNMIND_PROVIDER_REPLAY names a file and the app is not packaged.
//
// The file is JSON: { "delayMs"?: number, "rules": [{ "schema": "<a property of the reply's
// JSON schema>", "contains"?: "<text in the prompt>", "reply": <JSON value> | "all-different" }] }.
// The first matching rule answers. "all-different" answers every pair of a matching request with
// same: false. The string "FIRST_PAGE" in a reply becomes the number of the prompt's first
// [page N] marker. Each request is appended to <file>.log as one line of JSON (with a hash of the
// whole prompt and image), so tests can count calls and spot repeats.

interface Rule {
  schema: string
  contains?: string
  reply: unknown
}

interface ReplayFile {
  delayMs?: number
  rules: Rule[]
}

function answer(rules: Rule[], request: GenerateRequest): string {
  const keys = Object.keys((request.jsonSchema?.['properties'] ?? {}) as object)
  const rule = rules.find((r) => keys.includes(r.schema) && (r.contains === undefined || request.prompt.includes(r.contains)))
  if (!rule) throw new Error(`Replay file has no rule for a request with ${keys.join(', ') || 'no schema'}.`)
  if (rule.reply === 'all-different') {
    const ids = [...request.prompt.matchAll(/^([PQ]\d+) \(/gm)].map((m) => m[1])
    return JSON.stringify({ answers: ids.map((pair) => ({ pair, same: false })) })
  }
  const firstPage = /\[page (\d+)\]/.exec(request.prompt)?.[1] ?? '1'
  return JSON.stringify(rule.reply).replaceAll('"FIRST_PAGE"', firstPage)
}

export function createReplayAdapter(file: string): AdapterFactory {
  return () => ({
    id: 'gemini',
    listModels: async () => [{ id: 'replay-model', displayName: 'Replay model', description: '', inputTokenLimit: null, outputTokenLimit: null }],
    generate: async (request) => {
      const replay = JSON.parse(readFileSync(file, 'utf8')) as ReplayFile
      if (replay.delayMs) await new Promise((r) => setTimeout(r, replay.delayMs))
      const text = request.jsonSchema ? answer(replay.rules, request) : 'Replay reply.'
      const hash = createHash('sha256').update(request.prompt)
      for (const image of request.images ?? []) hash.update(image)
      const keys = Object.keys((request.jsonSchema?.['properties'] ?? {}) as object)
      appendFileSync(`${file}.log`, `${JSON.stringify({ keys, images: request.images?.length ?? 0, hash: hash.digest('hex') })}\n`)
      return { text, usage: { inputTokens: Math.ceil(request.prompt.length / 4) + (request.images?.length ?? 0) * 1120, outputTokens: Math.ceil(text.length / 4), thinkingTokens: 0 } }
    }
  })
}
