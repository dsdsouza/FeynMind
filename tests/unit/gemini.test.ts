import { describe, expect, it } from 'vitest'
import { createGeminiAdapter, GEMINI_BASE_URL } from '../../src/main/providers'

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

describe('Gemini adapter: generateText', () => {
  it('calls generateContent for the chosen model and returns the reply text', async () => {
    const { fetch, captured } = fakeFetch([
      json({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Message received!' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 }
      })
    ])

    const reply = await createGeminiAdapter({ apiKey: KEY, fetch }).generateText({
      modelId: 'gemini-2.5-flash-lite',
      prompt: 'Say hi'
    })

    expect(reply).toBe('Message received!')
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
      createGeminiAdapter({ apiKey: KEY, fetch }).generateText({ modelId: 'gemini-2.5-flash-lite', prompt: 'x' })
    ).rejects.toThrow(/Rate limit reached/)
    expect(captured).toHaveLength(1)
  })
})
