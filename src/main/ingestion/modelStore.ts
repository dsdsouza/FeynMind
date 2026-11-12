import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Downloads a pinned embedding model once, into the app's data folder, and verifies every file
// against a SHA-256 recorded here. A file that does not match is never used.

export interface ModelFile {
  path: string
  size: number
  sha256: string
}

export interface ModelSpec {
  /** Folder name under the models directory. */
  id: string
  /** Shown to the user. */
  name: string
  repo: string
  /** A fixed commit, so the files can never change underneath us. */
  revision: string
  files: ModelFile[]
}

/**
 * bge-small-en-v1.5 (BAAI, MIT license), int8-quantized ONNX export by Xenova.
 * Checksums were computed from the files at this revision on 2026-11-12; the ONNX file's hash
 * matches the one Hugging Face lists for it.
 */
export const BGE_SMALL_EN: ModelSpec = {
  id: 'bge-small-en-v1.5-ea104dac',
  name: 'bge-small-en-v1.5',
  repo: 'Xenova/bge-small-en-v1.5',
  revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
  files: [
    { path: 'onnx/model_quantized.onnx', size: 34014426, sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4' },
    { path: 'tokenizer.json', size: 711396, sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66' },
    { path: 'tokenizer_config.json', size: 366, sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3' }
  ]
}

/** Abandon a download when no data has arrived for this long. */
const STALL_TIMEOUT_MS = 60_000

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

export interface DownloadProgress {
  receivedBytes: number
  totalBytes: number
}

export function modelFolder(modelsDir: string, spec: ModelSpec): string {
  return join(modelsDir, spec.id)
}

export function totalSize(spec: ModelSpec): number {
  return spec.files.reduce((n, f) => n + f.size, 0)
}

/** True when every file of the model is present and matches its checksum. */
export async function isModelReady(modelsDir: string, spec: ModelSpec): Promise<boolean> {
  const folder = modelFolder(modelsDir, spec)
  for (const file of spec.files) {
    if (!(await fileMatches(join(folder, file.path), file))) return false
  }
  return true
}

/**
 * Makes sure the model is on disk, downloading any missing or damaged file from Hugging Face at the
 * pinned revision. Returns the model folder. Throws if a download fails or a checksum does not match;
 * the bad file is deleted.
 */
export async function ensureModel(
  modelsDir: string,
  spec: ModelSpec,
  options: {
    fetch: FetchFn
    onProgress?: (progress: DownloadProgress) => void
    signal?: AbortSignal
    /** How long a download may go without receiving data. */
    stallTimeoutMs?: number
  }
): Promise<string> {
  const folder = modelFolder(modelsDir, spec)
  const totalBytes = totalSize(spec)
  let doneBytes = 0
  for (const file of spec.files) {
    const target = join(folder, file.path)
    if (await fileMatches(target, file)) {
      doneBytes += file.size
      options.onProgress?.({ receivedBytes: doneBytes, totalBytes })
      continue
    }
    const before = doneBytes
    await downloadFile(`https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${file.path}`, target, file, {
      fetch: options.fetch,
      stallTimeoutMs: options.stallTimeoutMs ?? STALL_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      onBytes: (received) => options.onProgress?.({ receivedBytes: before + received, totalBytes })
    })
    doneBytes += file.size
  }
  return folder
}

async function downloadFile(
  url: string,
  target: string,
  expected: ModelFile,
  options: { fetch: FetchFn; signal?: AbortSignal; stallTimeoutMs: number; onBytes: (received: number) => void }
): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const partial = `${target}.part`
  // A connection can stall without failing; give up when no data arrives for a while.
  const stall = new AbortController()
  let stallTimer = setTimeout(() => stall.abort(), options.stallTimeoutMs)
  const resetStallTimer = (): void => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => stall.abort(), options.stallTimeoutMs)
  }
  const signal = options.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal
  try {
    await receive(url, partial, expected, { ...options, signal, onChunk: resetStallTimer })
  } catch (error) {
    if (stall.signal.aborted) throw new Error(`The download of ${expected.path} stalled. Check the connection and try again.`, { cause: error })
    throw error
  } finally {
    clearTimeout(stallTimer)
  }
  await rename(partial, target)
}

async function receive(
  url: string,
  partial: string,
  expected: ModelFile,
  options: { fetch: FetchFn; signal: AbortSignal; onBytes: (received: number) => void; onChunk: () => void }
): Promise<void> {
  const response = await options.fetch(url, { signal: options.signal })
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${expected.path} (HTTP ${response.status}).`)
  }
  const hash = createHash('sha256')
  const handle = await open(partial, 'w')
  let received = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      options.onChunk()
      received += value.byteLength
      if (received > expected.size) throw new Error(`${expected.path} is larger than expected.`)
      hash.update(value)
      await handle.write(value)
      options.onBytes(received)
    }
  } catch (error) {
    await handle.close()
    await rm(partial, { force: true })
    throw error
  }
  await handle.close()
  const digest = hash.digest('hex')
  if (received !== expected.size || digest !== expected.sha256) {
    await rm(partial, { force: true })
    throw new Error(`${expected.path} failed its checksum check, so it was discarded.`)
  }
}

async function fileMatches(path: string, expected: ModelFile): Promise<boolean> {
  if (!existsSync(path)) return false
  if ((await stat(path)).size !== expected.size) return false
  return (await sha256File(path)) === expected.sha256
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}
