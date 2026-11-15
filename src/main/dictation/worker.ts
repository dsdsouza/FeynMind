// The dictation process: an Electron utility process started by service.ts. It loads one Whisper
// model and turns audio into text, one request at a time, so recognition never freezes the window
// and a crash here cannot take the app down. It writes nothing to disk and makes no network calls.
import type { DictationToMain, MainToDictation } from './protocol'
import { createWhisperTranscriber, type Transcriber } from './whisper'

const port = process.parentPort
const send = (message: DictationToMain): void => port.postMessage(message)
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

let loaded: { modelId: string; transcriber: Transcriber } | null = null
// Requests run strictly in order: a transcription waits for an earlier load.
let queue: Promise<void> = Promise.resolve()

async function load(modelId: string, modelDir: string): Promise<void> {
  if (loaded?.modelId === modelId) return send({ type: 'loaded', modelId })
  try {
    const previous = loaded
    loaded = null
    await previous?.transcriber.close()
    loaded = { modelId, transcriber: await createWhisperTranscriber(modelDir) }
    send({ type: 'loaded', modelId })
  } catch (error) {
    send({ type: 'loadFailed', modelId, error: errorText(error) })
  }
}

async function transcribe(id: number, audio: Float32Array, previousText: string): Promise<void> {
  if (!loaded) return send({ type: 'failed', id, error: 'No speech model is loaded.' })
  const started = performance.now()
  try {
    const text = await loaded.transcriber.transcribe(audio, previousText)
    send({ type: 'result', id, text, ms: Math.round(performance.now() - started) })
  } catch (error) {
    send({ type: 'failed', id, error: errorText(error) })
  }
}

port.on('message', (event: { data: MainToDictation }) => {
  const message = event.data
  if (message.type === 'shutdown') {
    queue = queue.then(() => process.exit(0))
    return
  }
  queue = queue.then(() => (message.type === 'load' ? load(message.modelId, message.modelDir) : transcribe(message.id, message.audio, message.previousText)))
})
