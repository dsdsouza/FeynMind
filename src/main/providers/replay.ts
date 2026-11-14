import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import type { AdapterFactory, GenerateRequest, GenerateResult } from './types'

// A provider that answers from a file instead of the network, for end-to-end tests of the built
// app. It is used only when FEYNMIND_PROVIDER_REPLAY names a file and the app is not packaged.
//
// The file is JSON: { "delayMs"?: number, "rules": [{ "schema": "<a property of the reply's
// JSON schema>", "contains"?: "<text in the prompt>", "reply": <JSON value> | "all-different" }] }.
// The first matching rule answers. "all-different" answers every pair of a matching request with
// same: false. The string "FIRST_PAGE" in a reply becomes the number of the prompt's first
// [page N] marker, and FIRST_CITE becomes the first passage citation the prompt offers ("S1 p. 3").
// A plain-text request (no schema) is answered by the first rule with schema "text"; streamed
// requests get their reply in a few pieces. Each request is appended to <file>.log as one line of JSON (with a hash of the
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
  const keys = request.jsonSchema ? Object.keys((request.jsonSchema['properties'] ?? {}) as object) : ['text']
  const rule = rules.find((r) => keys.includes(r.schema) && (r.contains === undefined || request.prompt.includes(r.contains)))
  if (!rule && !request.jsonSchema) return 'Replay reply.'
  if (!rule) throw new Error(`Replay file has no rule for a request with ${keys.join(', ')}.`)
  if (rule.reply === 'all-different') {
    const ids = [...request.prompt.matchAll(/^([PQ]\d+) \(/gm)].map((m) => m[1])
    return JSON.stringify({ answers: ids.map((pair) => ({ pair, same: false })) })
  }
  const firstPage = /\[page (\d+)\]/.exec(request.prompt)?.[1] ?? '1'
  const firstCite = /\[(S\d+ p\. [^\]]+)\]/.exec(request.prompt)?.[1] ?? 'S1 p. 1'
  if (!request.jsonSchema) return String(rule.reply).replaceAll('FIRST_CITE', firstCite)
  return JSON.stringify(rule.reply).replaceAll('"FIRST_PAGE"', firstPage).replaceAll('FIRST_CITE', firstCite)
}

export function createReplayAdapter(file: string): AdapterFactory {
  const reply = async (request: GenerateRequest): Promise<GenerateResult> => {
    const replay = JSON.parse(readFileSync(file, 'utf8')) as ReplayFile
    if (replay.delayMs) await new Promise((r) => setTimeout(r, replay.delayMs))
    const text = answer(replay.rules, request)
    const hash = createHash('sha256').update(request.prompt)
    for (const image of request.images ?? []) hash.update(image)
    const keys = request.jsonSchema ? Object.keys((request.jsonSchema['properties'] ?? {}) as object) : ['text']
    appendFileSync(`${file}.log`, `${JSON.stringify({ keys, images: request.images?.length ?? 0, hash: hash.digest('hex') })}\n`)
    return { text, usage: { inputTokens: Math.ceil(request.prompt.length / 4) + (request.images?.length ?? 0) * 1120, outputTokens: Math.ceil(text.length / 4), thinkingTokens: 0 } }
  }
  return () => ({
    id: 'gemini',
    listModels: async () => [{ id: 'replay-model', displayName: 'Replay model', description: '', inputTokenLimit: null, outputTokenLimit: null }],
    generate: reply,
    stream: async (request, onText) => {
      const result = await reply(request)
      const pieces = result.text.match(/[\s\S]{1,40}/g) ?? []
      for (const piece of pieces) {
        onText(piece)
        await new Promise((r) => setTimeout(r, 20))
      }
      return result
    }
  })
}
