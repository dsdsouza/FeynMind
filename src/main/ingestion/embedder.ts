import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as Ort from 'onnxruntime-node'
import type { Tokenizer as TokenizerClass } from '@huggingface/tokenizers'

const require = createRequire(import.meta.url)

/**
 * Turns text into vectors for search. The rest of the app depends only on this interface, so the
 * model (or how it runs) can be swapped without touching ingestion or search.
 */
export interface Embedder {
  /** Identifies the model; vectors from different models must never be mixed. */
  readonly modelId: string
  readonly dimensions: number
  /** Vectors for passages to be searched. Unit length. */
  embedPassages(texts: string[]): Promise<Float32Array[]>
  /** The vector for a search question. Unit length. */
  embedQuery(text: string): Promise<Float32Array>
  close(): Promise<void>
}

/** BGE models expect this instruction in front of a search question (not in front of passages). */
const BGE_QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: '
const MAX_TOKENS = 512
const BATCH_SIZE = 16

/**
 * Runs bge-small-en-v1.5 with onnxruntime-node and the Hugging Face tokenizer. The embedding is the
 * normalized hidden state of the first ([CLS]) token, as the model's authors specify.
 * `modelDir` must contain the files listed in BGE_SMALL_EN (see modelStore.ts), already verified.
 */
export async function createBgeEmbedder(modelDir: string, modelId: string): Promise<Embedder> {
  const ort = require('onnxruntime-node') as typeof Ort
  const { Tokenizer } = require('@huggingface/tokenizers') as { Tokenizer: typeof TokenizerClass }
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    readFile(join(modelDir, 'tokenizer.json'), 'utf8'),
    readFile(join(modelDir, 'tokenizer_config.json'), 'utf8')
  ])
  const tokenizer = new Tokenizer(JSON.parse(tokenizerJson) as object, JSON.parse(tokenizerConfig) as object)
  const sepId = tokenizer.token_to_id('[SEP]')
  if (sepId === undefined) throw new Error('The embedding tokenizer has no [SEP] token.')

  const session = await ort.InferenceSession.create(join(modelDir, 'onnx', 'model_quantized.onnx'), {
    // Leave half the cores free so the rest of the computer stays responsive during a long import.
    intraOpNumThreads: Math.max(1, Math.floor(availableParallelism() / 2)),
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all'
  })
  const outputName = session.outputNames[0]
  if (!outputName) throw new Error('The embedding model has no output.')
  const dimensions = 384

  const encode = (text: string): number[] => {
    const ids = tokenizer.encode(text).ids
    // Keep [CLS] + the first tokens + [SEP] when a text is longer than the model accepts.
    return ids.length <= MAX_TOKENS ? ids : [...ids.slice(0, MAX_TOKENS - 1), sepId]
  }

  const run = async (texts: string[]): Promise<Float32Array[]> => {
    // Batch texts of similar length together: less padding is faster, and with dynamic int8
    // quantization padding shifts the vectors very slightly.
    const encoded = texts.map((text, index) => ({ index, ids: encode(text) }))
    const order = [...encoded].sort((a, b) => a.ids.length - b.ids.length)
    const vectors: Float32Array[] = new Array<Float32Array>(texts.length)
    for (let start = 0; start < order.length; start += BATCH_SIZE) {
      const items = order.slice(start, start + BATCH_SIZE)
      const batch = items.map((item) => item.ids)
      const length = Math.max(...batch.map((ids) => ids.length))
      const ids = new BigInt64Array(batch.length * length)
      const mask = new BigInt64Array(batch.length * length)
      batch.forEach((row, r) => {
        row.forEach((id, c) => {
          ids[r * length + c] = BigInt(id)
          mask[r * length + c] = 1n
        })
      })
      const shape = [batch.length, length]
      const feeds: Record<string, Ort.Tensor> = {
        input_ids: new ort.Tensor('int64', ids, shape),
        attention_mask: new ort.Tensor('int64', mask, shape)
      }
      if (session.inputNames.includes('token_type_ids')) {
        feeds['token_type_ids'] = new ort.Tensor('int64', new BigInt64Array(batch.length * length), shape)
      }
      const output = (await session.run(feeds))[outputName]
      if (!output) throw new Error('The embedding model returned no output.')
      const hidden = output.data as Float32Array
      for (let r = 0; r < batch.length; r++) {
        const offset = r * length * dimensions
        vectors[items[r]?.index ?? 0] = normalize(hidden.slice(offset, offset + dimensions))
      }
      output.dispose()
    }
    return vectors
  }

  return {
    modelId,
    dimensions,
    embedPassages: (texts) => run(texts),
    embedQuery: async (text) => {
      const [vector] = await run([BGE_QUERY_INSTRUCTION + text])
      if (!vector) throw new Error('The embedding model returned no vector.')
      return vector
    },
    close: () => session.release()
  }
}

function normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (const x of vector) sum += x * x
  const norm = Math.sqrt(sum) || 1
  return vector.map((x) => x / norm)
}
