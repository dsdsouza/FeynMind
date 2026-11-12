import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureModel, isModelReady, modelFolder, type FetchFn, type ModelSpec } from '../../src/main/ingestion/modelStore'

const content = { 'weights.bin': Buffer.from('pretend model weights'), 'tokenizer.json': Buffer.from('{"vocab":{}}') }
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

const spec: ModelSpec = {
  id: 'test-model-1234',
  name: 'test model',
  repo: 'example/test-model',
  revision: 'abc123',
  files: Object.entries(content).map(([path, data]) => ({ path, size: data.length, sha256: sha(data) }))
}

/** Serves `files` by URL suffix and records every requested URL. */
function fakeFetch(files: Record<string, Buffer>, requested: string[]): FetchFn {
  return async (url) => {
    requested.push(url)
    const name = Object.keys(files).find((f) => url.endsWith(`/${f}`))
    return name ? new Response(new Uint8Array(files[name] ?? Buffer.alloc(0))) : new Response('missing', { status: 404 })
  }
}

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('model store', () => {
  it('downloads every file from the pinned revision, verifies it and reports progress', async () => {
    dir = mkdtempSync(join(tmpdir(), 'feynmind-models-'))
    const requested: string[] = []
    const progress: number[] = []
    const folder = await ensureModel(dir, spec, { fetch: fakeFetch(content, requested), onProgress: (p) => progress.push(p.receivedBytes) })

    expect(requested).toEqual([
      'https://huggingface.co/example/test-model/resolve/abc123/weights.bin',
      'https://huggingface.co/example/test-model/resolve/abc123/tokenizer.json'
    ])
    expect(readFileSync(join(folder, 'weights.bin'))).toEqual(content['weights.bin'])
    expect(progress.at(-1)).toBe(content['weights.bin'].length + content['tokenizer.json'].length)
    expect(await isModelReady(dir, spec)).toBe(true)

    // A second call finds the files on disk and downloads nothing.
    requested.length = 0
    await ensureModel(dir, spec, { fetch: fakeFetch(content, requested) })
    expect(requested).toEqual([])
  })

  it('discards a file whose checksum does not match', async () => {
    dir = mkdtempSync(join(tmpdir(), 'feynmind-models-'))
    const tampered = { ...content, 'weights.bin': Buffer.from('pretend model weightz') }
    await expect(ensureModel(dir, spec, { fetch: fakeFetch(tampered, []) })).rejects.toThrow(/checksum/)
    expect(existsSync(join(modelFolder(dir, spec), 'weights.bin'))).toBe(false)
    expect(existsSync(join(modelFolder(dir, spec), 'weights.bin.part'))).toBe(false)
    expect(await isModelReady(dir, spec)).toBe(false)
  })

  it('replaces a damaged file already on disk', async () => {
    dir = mkdtempSync(join(tmpdir(), 'feynmind-models-'))
    mkdirSync(modelFolder(dir, spec), { recursive: true })
    writeFileSync(join(modelFolder(dir, spec), 'weights.bin'), 'corrupted on disk!!!!')
    expect(await isModelReady(dir, spec)).toBe(false)
    await ensureModel(dir, spec, { fetch: fakeFetch(content, []) })
    expect(await isModelReady(dir, spec)).toBe(true)
  })

  it('fails clearly when the server refuses', async () => {
    dir = mkdtempSync(join(tmpdir(), 'feynmind-models-'))
    await expect(ensureModel(dir, spec, { fetch: fakeFetch({}, []) })).rejects.toThrow(/HTTP 404/)
  })

  it('gives up on a download that stops sending data', async () => {
    dir = mkdtempSync(join(tmpdir(), 'feynmind-models-'))
    // Sends one chunk, then nothing, until the request is aborted.
    const stalling: FetchFn = async (_url, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]))
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason))
          }
        })
      )
    await expect(ensureModel(dir, spec, { fetch: stalling, stallTimeoutMs: 50 })).rejects.toThrow(/stalled/)
    expect(existsSync(join(modelFolder(dir, spec), 'weights.bin.part'))).toBe(false)
  })
})
