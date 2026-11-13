import { createHash } from 'node:crypto'
import type { ThinkingLevel } from '../providers'

// Prompt files in prompts/ start with a header of `key: value` lines, then a `---system` part and
// a `---user` part. The user part is a template with {{name}} placeholders.

export interface PromptFile {
  name: string
  version: number
  thinking: ThinkingLevel
  maxOutputTokens: number
  /** Expected output tokens: outputBase + outputRatio × tokens of the filled-in placeholders. */
  outputBase: number
  outputRatio: number
  system: string
  template: string
  /** Hash of the whole file: any edit to the prompt changes the cache key of what it produces. */
  hash: string
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high']

export function parsePromptFile(name: string, raw: string): PromptFile {
  const text = raw.replace(/\r\n/g, '\n')
  const systemAt = text.indexOf('\n---system\n')
  const userAt = text.indexOf('\n---user\n')
  if (systemAt < 0 || userAt < systemAt) throw new Error(`Prompt ${name} must have a header, then ---system, then ---user.`)
  const header = new Map<string, string>()
  for (const line of text.slice(0, systemAt).split('\n')) {
    if (line.trim() === '') continue
    const match = /^([a-z-]+):\s*(.+)$/.exec(line.trim())
    if (!match?.[1] || !match[2]) throw new Error(`Prompt ${name}: bad header line "${line}".`)
    header.set(match[1], match[2].trim())
  }
  const number = (key: string): number => {
    const value = Number(header.get(key))
    if (!header.has(key) || !Number.isFinite(value) || value < 0) throw new Error(`Prompt ${name}: header "${key}" must be a number.`)
    return value
  }
  const thinking = header.get('thinking') as ThinkingLevel | undefined
  if (!thinking || !THINKING_LEVELS.includes(thinking)) throw new Error(`Prompt ${name}: header "thinking" must be one of ${THINKING_LEVELS.join(', ')}.`)
  const version = number('version')
  if (!Number.isInteger(version) || version < 1) throw new Error(`Prompt ${name}: version must be a whole number from 1.`)
  return {
    name,
    version,
    thinking,
    maxOutputTokens: number('max-output-tokens'),
    outputBase: number('output-base'),
    outputRatio: number('output-ratio'),
    system: text.slice(systemAt + '\n---system\n'.length, userAt).trim(),
    template: text.slice(userAt + '\n---user\n'.length).trim(),
    hash: createHash('sha256').update(text).digest('hex')
  }
}

/** Fills the template's placeholders. Every placeholder needs a value, and every value a placeholder. */
export function renderPrompt(prompt: PromptFile, values: Record<string, string>): string {
  const used = new Set<string>()
  const result = prompt.template.replace(/\{\{([a-z]+)\}\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`Prompt ${prompt.name} needs a value for {{${key}}}.`)
    used.add(key)
    return value
  })
  const unused = Object.keys(values).filter((k) => !used.has(k))
  if (unused.length > 0) throw new Error(`Prompt ${prompt.name} has no placeholder for ${unused.join(', ')}.`)
  return result
}

/** Loads prompt files once and keeps them for the life of the app. */
export class PromptLibrary {
  private readonly cache = new Map<string, PromptFile>()
  constructor(private readonly load: (name: string) => string) {}

  get(name: string): PromptFile {
    let prompt = this.cache.get(name)
    if (!prompt) {
      prompt = parsePromptFile(name, this.load(name))
      this.cache.set(name, prompt)
    }
    return prompt
  }
}
