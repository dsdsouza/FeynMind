import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import type * as Ort from 'onnxruntime-node'
import type { Tokenizer as TokenizerClass } from '@huggingface/tokenizers'
import { cleanTranscript, splitIntoWindows } from './audio'
import { logMelSpectrogram, N_FRAMES, N_MELS } from './mel'

const require = createRequire(import.meta.url)

/** Turns 16 kHz mono audio into text, on this machine. */
export interface Transcriber {
  transcribe(audio: Float32Array): Promise<string>
  close(): Promise<void>
}

interface ModelConfig {
  decoder_layers: number
  decoder_attention_heads: number
  d_model: number
}

interface GenerationConfig {
  decoder_start_token_id: number
  eos_token_id: number
  no_timestamps_token_id: number
  forced_decoder_ids: [number, number][]
  suppress_tokens: number[]
  begin_suppress_tokens: number[]
  max_length: number
}

/** Tokens per 30 s window; Whisper's own limit is half its 448-token context. */
const MAX_NEW_TOKENS = 224

/**
 * Loads an English-only Whisper model exported to ONNX (encoder plus merged decoder with a key/value
 * cache) and transcribes with greedy decoding, without timestamps. `modelDir` must hold the files of
 * one of SPEECH_MODELS (see models.ts), already verified.
 */
export async function createWhisperTranscriber(modelDir: string): Promise<Transcriber> {
  const ort = require('onnxruntime-node') as typeof Ort
  const { Tokenizer } = require('@huggingface/tokenizers') as { Tokenizer: typeof TokenizerClass }
  const readJson = async <T>(name: string): Promise<T> => JSON.parse(await readFile(join(modelDir, name), 'utf8')) as T
  const [config, generation, tokenizerJson, tokenizerConfig] = await Promise.all([
    readJson<ModelConfig>('config.json'),
    readJson<GenerationConfig>('generation_config.json'),
    readJson<object>('tokenizer.json'),
    readJson<object>('tokenizer_config.json')
  ])
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig)
  const options: Ort.InferenceSession.SessionOptions = {
    // Leave half the cores free so the window and an import keep going while we transcribe.
    intraOpNumThreads: Math.max(1, Math.floor(availableParallelism() / 2)),
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    extra: { session: { intra_op: { allow_spinning: '0' } } }
  }
  const [encoder, decoder] = await Promise.all([
    ort.InferenceSession.create(join(modelDir, 'onnx', 'encoder_model_quantized.onnx'), options),
    ort.InferenceSession.create(join(modelDir, 'onnx', 'decoder_model_merged_quantized.onnx'), options)
  ])

  const layers = config.decoder_layers
  const heads = config.decoder_attention_heads
  const headDim = config.d_model / heads
  const prompt = [generation.decoder_start_token_id, ...generation.forced_decoder_ids.sort((a, b) => a[0] - b[0]).map(([, id]) => id)]
  const suppressed = new Set(generation.suppress_tokens)
  const beginSuppressed = new Set(generation.begin_suppress_tokens)
  // Timestamp tokens come after <|notimestamps|>; we never want them.
  const firstTimestamp = generation.no_timestamps_token_id + 1
  const emptyCache = (): Ort.Tensor => new ort.Tensor('float32', new Float32Array(0), [1, heads, 0, headDim])
  const presents = (parts: string[]): string[] => Array.from({ length: layers }, (_, l) => parts.map((p) => `present.${l}.${p}`)).flat()
  const laterFetches = ['logits', ...presents(['decoder.key', 'decoder.value'])]
  const firstFetches = [...laterFetches, ...presents(['encoder.key', 'encoder.value'])]

  async function transcribeWindow(audio: Float32Array): Promise<string> {
    const features = new ort.Tensor('float32', logMelSpectrogram(audio), [1, N_MELS, N_FRAMES])
    const encoded = await encoder.run({ input_features: features })
    const hidden = encoded['last_hidden_state']
    if (!hidden) throw new Error('The speech model returned no encoder output.')

    const cache: Record<string, Ort.Tensor> = {}
    for (let l = 0; l < layers; l++) {
      for (const part of ['decoder.key', 'decoder.value', 'encoder.key', 'encoder.value']) cache[`past_key_values.${l}.${part}`] = emptyCache()
    }
    const output: number[] = []
    let input = prompt
    for (let step = 0; step < MAX_NEW_TOKENS; step++) {
      const result = await decoder.run(
        {
          input_ids: new ort.Tensor('int64', BigInt64Array.from(input, (t) => BigInt(t)), [1, input.length]),
          encoder_hidden_states: hidden,
          use_cache_branch: new ort.Tensor('bool', [step > 0], [1]),
          ...cache
        },
        // Only fetch what is used: after the first step the encoder's keys and values are passed
        // through unchanged, and copying them out (about 37 MB for base) tripled each step's time.
        step === 0 ? firstFetches : laterFetches
      )
      const logits = result['logits']
      if (!logits) throw new Error('The speech model returned no logits.')
      const vocab = logits.dims[2] ?? 0
      const data = logits.data as Float32Array
      const offset = (input.length - 1) * vocab
      let best = -1
      let bestScore = -Infinity
      for (let id = 0; id < vocab; id++) {
        if (id >= firstTimestamp || suppressed.has(id) || (step === 0 && beginSuppressed.has(id))) continue
        const score = data[offset + id] ?? -Infinity
        if (score > bestScore) {
          bestScore = score
          best = id
        }
      }
      if (best < 0 || best === generation.eos_token_id) break
      output.push(best)
      for (let l = 0; l < layers; l++) {
        for (const part of ['decoder.key', 'decoder.value']) {
          const present = result[`present.${l}.${part}`]
          if (present) cache[`past_key_values.${l}.${part}`] = present
        }
        // The encoder's keys and values are computed on the first step only; later steps return
        // placeholders for them, so the first ones are kept.
        if (step === 0) {
          for (const part of ['encoder.key', 'encoder.value']) {
            const present = result[`present.${l}.${part}`]
            if (present) cache[`past_key_values.${l}.${part}`] = present
          }
        }
      }
      input = [best]
    }
    return tokenizer.decode(output, { skip_special_tokens: true })
  }

  return {
    async transcribe(audio) {
      const pieces: string[] = []
      for (const window of splitIntoWindows(audio)) pieces.push(await transcribeWindow(window))
      return cleanTranscript(pieces)
    },
    async close() {
      await Promise.all([encoder.release(), decoder.release()])
    }
  }
}
