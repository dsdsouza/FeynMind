import type { SectionContent, PageForVision } from '../ingestion'
import type { ModelTask } from '../providers'
import { renderPrompt, type PromptFile } from './prompts'
import {
  EXTRACTION_JSON_SCHEMA,
  MAP_JSON_SCHEMA,
  MATCH_JSON_SCHEMA,
  parseExtraction,
  parseMapping,
  parseMatch,
  parseSyllabus,
  parseTranscription,
  SYLLABUS_JSON_SCHEMA,
  TRANSCRIPTION_JSON_SCHEMA,
  type ExtractedConcept,
  type ParsedSyllabus,
  type Transcription
} from './schemas'

// Builds the model task for each kind of request: the prompt filled in, the key of the content it
// depends on (for the cache), the token estimate, and the check its reply must pass.

/** Gemini 3 bills an image at high media resolution as this many input tokens (media-resolution page, checked 2026-11-13). */
export const IMAGE_TOKENS = 1120
/** Must match VISION_DPI in the ingestion worker: the rendered image is part of what a transcription depends on. */
export const VISION_RENDER = 'png@150dpi'
/** Unclear pairs sent to the model in one request. */
export const MATCH_BATCH = 30

/** Rough token count of English text with some LaTeX; calibrated against real usage over time. */
export function textTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface Calibration {
  inputFactor: number
  outputFactor: number
  samples: number
}

/** Calibration factors pulled toward 1 while there are few samples, so one odd call cannot swing estimates. */
export function damped(c: Calibration): { input: number; output: number } {
  const weight = c.samples / (c.samples + 3)
  return { input: 1 + (c.inputFactor - 1) * weight, output: 1 + (c.outputFactor - 1) * weight }
}

/** What a task is expected to cost in tokens, before calibration. */
export function rawEstimate(prompt: PromptFile, rendered: string, variableText: string, images: number): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: textTokens(prompt.system) + textTokens(rendered) + images * IMAGE_TOKENS,
    outputTokens: Math.round(prompt.outputBase + prompt.outputRatio * textTokens(variableText))
  }
}

export interface TaskContext {
  sessionId: number
  jobId: number | null
  calibration: Calibration
  signal?: AbortSignal
}

type Built<T> = Omit<ModelTask<T>, 'sessionId' | 'jobId' | 'signal'>

function finish<T>(built: Built<T>, ctx: TaskContext): ModelTask<T> {
  const f = damped(ctx.calibration)
  return {
    ...built,
    sessionId: ctx.sessionId,
    jobId: ctx.jobId,
    estimate: { inputTokens: Math.round(built.estimate.inputTokens * f.input), outputTokens: Math.round(built.estimate.outputTokens * f.output) },
    ...(ctx.signal ? { signal: ctx.signal } : {})
  }
}

function base(prompt: PromptFile, rendered: string, variableText: string, images: number): Pick<Built<unknown>, 'role' | 'prompt' | 'system' | 'text' | 'thinking' | 'maxOutputTokens' | 'estimate'> {
  return {
    role: 'ingestion',
    prompt: { name: prompt.name, version: prompt.version, hash: prompt.hash },
    system: prompt.system,
    text: rendered,
    thinking: prompt.thinking,
    maxOutputTokens: prompt.maxOutputTokens,
    estimate: rawEstimate(prompt, rendered, variableText, images)
  }
}

// Transcription

export function numberedLines(page: PageForVision): string {
  return page.lines.length === 0 ? '(no extracted text)' : page.lines.map((l, i) => `${i}: ${l.text}`).join('\n')
}

/** The content a page's transcription depends on: the file, the page, how it was rendered and its extracted lines. */
export function transcriptionKey(materialSha: string, page: PageForVision): string {
  return JSON.stringify(['transcribe', materialSha, page.pageIndex, VISION_RENDER, numberedLines(page)])
}

export function transcriptionTask(prompt: PromptFile, page: PageForVision, materialSha: string, image: Uint8Array | null, ctx: TaskContext): ModelTask<Transcription> {
  const lines = numberedLines(page)
  const rendered = renderPrompt(prompt, { lines })
  return finish(
    {
      ...base(prompt, rendered, lines, 1),
      ...(image ? { images: [image] } : {}),
      jsonSchema: TRANSCRIPTION_JSON_SCHEMA,
      contentKey: transcriptionKey(materialSha, page),
      parse: (text) => parseTranscription(text, page.lines.length)
    },
    ctx
  )
}

// Concept extraction

export function sectionText(content: SectionContent): string {
  return content.pages.map((p) => `[page ${p.index}]\n${p.text}`).join('\n\n')
}

function extractionValues(content: SectionContent): Record<string, string> {
  return {
    book: content.fileName,
    chapter: content.chapter ?? '(none)',
    section: content.section ?? '(none)',
    text: sectionText(content)
  }
}

export function extractionKey(prompt: PromptFile, content: SectionContent): string {
  return JSON.stringify(['extract', content.materialSha, renderPrompt(prompt, extractionValues(content))])
}

export function extractionTask(prompt: PromptFile, content: SectionContent, ctx: TaskContext): ModelTask<ExtractedConcept[]> {
  const values = extractionValues(content)
  const rendered = renderPrompt(prompt, values)
  const pages = new Set(content.pages.map((p) => p.index))
  return finish(
    {
      ...base(prompt, rendered, values['text'] ?? '', 0),
      jsonSchema: EXTRACTION_JSON_SCHEMA,
      contentKey: extractionKey(prompt, content),
      parse: (text) => parseExtraction(text, pages)
    },
    ctx
  )
}

// Matching

export interface MatchPair {
  id: string
  kind: 'concept' | 'prerequisite'
  a: { name: string; definition: string | null }
  b: { name: string; definition: string }
}

function describe(item: { name: string; definition: string | null }): string {
  return item.definition ? `${item.name}: ${item.definition}` : item.name
}

export function matchTask(prompt: PromptFile, pairs: MatchPair[], ctx: TaskContext): ModelTask<Map<string, boolean>> {
  const text = pairs
    .map((p) => (p.kind === 'concept' ? `${p.id} (concept)\nA: ${describe(p.a)}\nB: ${describe(p.b)}` : `${p.id} (prerequisite)\nName: ${p.a.name}\nCandidate: ${describe(p.b)}`))
    .join('\n\n')
  const rendered = renderPrompt(prompt, { pairs: text })
  const ids = pairs.map((p) => p.id)
  return finish(
    {
      ...base(prompt, rendered, text, 0),
      jsonSchema: MATCH_JSON_SCHEMA,
      contentKey: JSON.stringify(['match', text]),
      parse: (reply) => parseMatch(reply, ids)
    },
    ctx
  )
}

/** A typical request's size, for estimating the matching calls before the concepts exist. */
export function typicalMatchEstimate(prompt: PromptFile): { inputTokens: number; outputTokens: number } {
  const perPair = 'P1 (concept)\nA: inverse of a matrix: The matrix that multiplied by A gives the identity matrix.\nB: matrix inverse: A matrix B with AB = BA = I.\n\n'
  const sample = perPair.repeat(12)
  return rawEstimate(prompt, `${prompt.template}${sample}`, sample, 0)
}

// Syllabus

export function syllabusParseTask(prompt: PromptFile, syllabus: string, ctx: TaskContext): ModelTask<ParsedSyllabus> {
  const rendered = renderPrompt(prompt, { syllabus })
  return finish(
    { ...base(prompt, rendered, syllabus, 0), jsonSchema: SYLLABUS_JSON_SCHEMA, contentKey: JSON.stringify(['syllabus', syllabus]), parse: parseSyllabus },
    ctx
  )
}

export interface TocLine {
  id: string
  text: string
}

export function syllabusMapTask(prompt: PromptFile, units: ParsedSyllabus['units'], toc: TocLine[], ctx: TaskContext): ModelTask<Map<number, string[]>> {
  const unitText = units
    .map((u, i) => `${i}. ${u.title}${u.topics.length ? ` | topics: ${u.topics.join('; ')}` : ''}${u.readings.length ? ` | readings: ${u.readings.join('; ')}` : ''}`)
    .join('\n')
  const tocText = toc.map((t) => `${t.id} | ${t.text}`).join('\n')
  const rendered = renderPrompt(prompt, { units: unitText, toc: tocText })
  const ids = new Set(toc.map((t) => t.id))
  return finish(
    {
      ...base(prompt, rendered, unitText, 0),
      jsonSchema: MAP_JSON_SCHEMA,
      contentKey: JSON.stringify(['map', unitText, tocText]),
      parse: (text) => parseMapping(text, units.length, ids)
    },
    ctx
  )
}

/** An estimate for mapping before the syllabus is read: assume a unit line per 150 characters of syllabus. */
export function mapEstimateBeforeParse(prompt: PromptFile, syllabusChars: number, toc: TocLine[]): { inputTokens: number; outputTokens: number } {
  const unitText = 'x'.repeat(Math.min(syllabusChars, 6000) / 3)
  const tocText = toc.map((t) => `${t.id} | ${t.text}`).join('\n')
  return rawEstimate(prompt, `${prompt.template}${unitText}${tocText}`, unitText, 0)
}
