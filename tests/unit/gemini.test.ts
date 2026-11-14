import { describe, expect, it } from 'vitest'
import { createGeminiAdapter, GEMINI_BASE_URL } from '../../src/main/providers'
import { classifyGeminiError } from '../../src/main/providers/gemini'

const KEY = 'test-key-not-real-123'

interface Captured {
  url: string
  headers: Headers
  body: unknown
}

/** Builds a fake fetch that answers from a queue and records each request. */
function fakeFetch(responses: Response[]) {
  const captured: Captured[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    const raw = input instanceof Request ? await input.text() : init?.body
    captured.push({ url, headers, body: typeof raw === 'string' && raw ? JSON.parse(raw) : undefined })
    const next = responses.shift()
    if (!next) throw new Error('fake fetch: no response queued')
    return next
  }) as typeof globalThis.fetch
  return { fetch, captured }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Gemini adapter: listModels', () => {
  it('follows pagination, keeps only generateContent models and sorts by id', async () => {
    const { fetch, captured } = fakeFetch([
      json({
        models: [
          { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'], inputTokenLimit: 1048576 },
          { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] }
        ],
        nextPageToken: 'page2'
      }),
      json({ models: [{ name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] }] })
    ])

    const models = await createGeminiAdapter({ apiKey: KEY, fetch }).listModels()

    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-flash-lite', 'gemini-3.6-flash'])
    expect(models[1]).toMatchObject({ displayName: 'Gemini 3.6 Flash', inputTokenLimit: 1048576 })
    expect(models[0]?.displayName).toBe('gemini-2.5-flash-lite')
    expect(captured).toHaveLength(2)
    expect(captured[0]?.url).toBe(`${GEMINI_BASE_URL}/models?pageSize=1000`)
    expect(captured[1]?.url).toContain('pageToken=page2')
  })

  it('sends the key in a header and never in the URL', async () => {
    const { fetch, captured } = fakeFetch([json({ models: [] })])
    await createGeminiAdapter({ apiKey: KEY, fetch }).listModels()
    expect(captured[0]?.headers.get('x-goog-api-key')).toBe(KEY)
    expect(captured[0]?.url).not.toContain(KEY)
  })

  it('turns an HTTP error into a readable message', async () => {
    const { fetch } = fakeFetch([json({ error: { message: 'API key not valid.' } }, 400)])
    await expect(createGeminiAdapter({ apiKey: KEY, fetch }).listModels()).rejects.toThrow(
      'The provider rejected the API key or request (API key not valid.).'
    )
  })

  it('reports rate limiting', async () => {
    const { fetch } = fakeFetch([json({ error: { message: 'Quota exceeded' } }, 429)])
    await expect(createGeminiAdapter({ apiKey: KEY, fetch }).listModels()).rejects.toThrow(/Rate limit reached/)
  })
})

describe('Gemini adapter: generate', () => {
  it('calls generateContent for the chosen model and returns the reply text', async () => {
    const { fetch, captured } = fakeFetch([
      json({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Message received!' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 }
      })
    ])

    const reply = await createGeminiAdapter({ apiKey: KEY, fetch }).generate({
      modelId: 'gemini-2.5-flash-lite',
      prompt: 'Say hi'
    })

    expect(reply.text).toBe('Message received!')
    expect(reply.usage).toEqual({ inputTokens: 5, outputTokens: 3, thinkingTokens: 0 })
    expect(captured).toHaveLength(1)
    expect(captured[0]?.url).toBe(`${GEMINI_BASE_URL}/models/gemini-2.5-flash-lite:generateContent`)
    expect(captured[0]?.headers.get('x-goog-api-key')).toBe(KEY)
    expect(JSON.stringify(captured[0]?.body)).toContain('Say hi')
  })

  it('makes exactly one attempt on a rate-limit error (no retries)', async () => {
    const { fetch, captured } = fakeFetch([
      json({ error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }, 429),
      json({ error: { code: 429, message: 'Resource exhausted' } }, 429)
    ])
    await expect(
      createGeminiAdapter({ apiKey: KEY, fetch }).generate({ modelId: 'gemini-2.5-flash-lite', prompt: 'x' })
    ).rejects.toThrow(/Rate limit reached/)
    expect(captured).toHaveLength(1)
  })
})

describe('Gemini adapter: images, structured output and usage', () => {
  const reply = (text: string, usage: Record<string, number> = { promptTokenCount: 1200, candidatesTokenCount: 40, thoughtsTokenCount: 10, totalTokenCount: 1250 }) =>
    json({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: usage })

  it('sends images, the schema, the thinking level and high media resolution', async () => {
    const { fetch, captured } = fakeFetch([reply('{"blocks":[]}')])
    const result = await createGeminiAdapter({ apiKey: KEY, fetch }).generate({
      modelId: 'gemini-3.1-flash-lite',
      system: 'You transcribe pages.',
      prompt: 'Transcribe this page.',
      images: [new Uint8Array([137, 80, 78, 71])],
      jsonSchema: { type: 'object', properties: { blocks: { type: 'array', items: { type: 'object', properties: {} } } }, required: ['blocks'] },
      thinking: 'minimal',
      maxOutputTokens: 2000
    })
    expect(result.text).toBe('{"blocks":[]}')
    interface Body {
      contents: { parts: { inlineData?: { mimeType: string } }[] }[]
      systemInstruction: unknown
      generationConfig: Record<string, unknown>
    }
    const body = captured[0]?.body as Body
    const parts = body.contents[0]?.parts ?? []
    expect(parts.some((p) => p.inlineData?.mimeType === 'image/png')).toBe(true)
    expect(JSON.stringify(body.systemInstruction)).toContain('You transcribe pages.')
    expect(body.generationConfig['responseMimeType']).toBe('application/json')
    expect(body.generationConfig['responseJsonSchema']).toBeDefined()
    expect(body.generationConfig['thinkingConfig']).toEqual({ thinkingLevel: 'minimal' })
    expect(body.generationConfig['mediaResolution']).toBe('MEDIA_RESOLUTION_HIGH')
    expect(body.generationConfig['maxOutputTokens']).toBe(2000)
  })

  it('bills thinking as output', async () => {
    const { fetch } = fakeFetch([reply('{"blocks":[]}')])
    const result = await createGeminiAdapter({ apiKey: KEY, fetch }).generate({ modelId: 'm', prompt: 'x', jsonSchema: { type: 'object' } })
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 50, thinkingTokens: 10 })
  })

  it('returns a reply that is not valid JSON, with its usage, for the caller to reject', async () => {
    const { fetch } = fakeFetch([reply('not json at all')])
    const result = await createGeminiAdapter({ apiKey: KEY, fetch }).generate({ modelId: 'm', prompt: 'x', jsonSchema: { type: 'object' } })
    expect(result.text).toBe('not json at all')
    expect(result.usage.inputTokens).toBe(1200)
  })
})

describe('classifyGeminiError', () => {
  const body = (details: unknown[]) => JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED', details } })

  it('reads the retry delay of a per-minute limit', () => {
    const error = classifyGeminiError(
      429,
      body([
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '21s' }
      ])
    )
    expect(error).toMatchObject({ kind: 'rate-limit', retryAfterMs: 21_000 })
  })

  it('treats a per-day quota as exhausted until the reset', () => {
    const error = classifyGeminiError(
      429,
      body([
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3600s' }
      ])
    )
    expect(error.kind).toBe('quota-daily')
  })

  it('treats a bare 429 as a short-term limit with no known delay', () => {
    expect(classifyGeminiError(429, '{"error":{"code":429,"message":"Resource exhausted"}}')).toMatchObject({ kind: 'rate-limit', retryAfterMs: null })
    expect(classifyGeminiError(429, undefined)).toMatchObject({ kind: 'rate-limit', retryAfterMs: null })
  })

  it('classifies other statuses', () => {
    expect(classifyGeminiError(503, '{"error":{"message":"The model is overloaded."}}').kind).toBe('overloaded')
    expect(classifyGeminiError(500, undefined).kind).toBe('overloaded')
    expect(classifyGeminiError(403, undefined).kind).toBe('auth')
    expect(classifyGeminiError(404, undefined).kind).toBe('not-found')
    expect(classifyGeminiError(400, undefined).kind).toBe('bad-request')
  })
})

describe('Gemini adapter: streaming', () => {
  // streamGenerateContent with alt=sse answers with server-sent events, one GenerateContentResponse per event.
  const sse = (events: unknown[]) =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })

  it('passes each piece of text on as it arrives and returns the whole reply with billed tokens', async () => {
    const { fetch, captured } = fakeFetch([
      sse([
        { candidates: [{ content: { role: 'model', parts: [{ text: '## Expla' }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: 'nation\nVectors.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 6, thoughtsTokenCount: 2, totalTokenCount: 58 } }
      ])
    ])
    const pieces: string[] = []
    const reply = await createGeminiAdapter({ apiKey: KEY, fetch }).stream({ modelId: 'gemini-3.1-flash-lite', prompt: 'Explain', thinking: 'minimal' }, (t) => pieces.push(t))
    expect(pieces).toEqual(['## Expla', 'nation\nVectors.'])
    expect(reply.text).toBe('## Explanation\nVectors.')
    expect(reply.usage).toEqual({ inputTokens: 50, outputTokens: 8, thinkingTokens: 2 })
    expect(captured).toHaveLength(1)
    expect(captured[0]?.url).toContain(':streamGenerateContent')
  })

  it('reports an HTTP error as a classified provider error after one attempt', async () => {
    const { fetch, captured } = fakeFetch([
      json({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }, 503),
      json({ error: { code: 503, message: 'again' } }, 503)
    ])
    await expect(createGeminiAdapter({ apiKey: KEY, fetch }).stream({ modelId: 'gemini-3.1-flash-lite', prompt: 'x' }, () => undefined)).rejects.toMatchObject({ kind: 'overloaded' })
    expect(captured).toHaveLength(1)
  })
})
