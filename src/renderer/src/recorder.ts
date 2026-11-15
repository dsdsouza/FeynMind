// Microphone capture for dictation: 16 kHz mono samples, handed over in chunks of about a quarter
// second. Audio is only ever held in memory and passed to the background process; nothing is saved.
//
// A ScriptProcessorNode is used rather than an AudioWorklet: a worklet module must be fetched from
// a URL, which a page loaded from file:// (the packaged app) under our content security policy
// cannot do reliably. The node is deprecated but supported by Chromium; if it is ever removed,
// switch to a worklet served from the app's own protocol.

const SAMPLE_RATE = 16_000
const BUFFER = 4096

export interface Recorder {
  stop(): void
}

/** What the learner sees when the microphone cannot be used. */
export function microphoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Microphone access is blocked. Allow FeynMind to use the microphone in your system’s privacy settings (on Windows: Settings › Privacy & security › Microphone, including “Let desktop apps access your microphone”), then try again. You can always type instead.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Connect one and try again, or type instead.'
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone could not be started. Another app may be using it. Close it and try again, or type instead.'
  return error instanceof Error ? `The microphone could not be started: ${error.message}` : 'The microphone could not be started.'
}

/** Starts the microphone. `onChunk` receives samples in [-1, 1]; `onLevel` a loudness from 0 to 1. */
export async function startRecorder(onChunk: (samples: Float32Array) => void, onLevel: (level: number) => void): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
  // The context resamples the microphone to Whisper's 16 kHz.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(BUFFER, 1, 1)
  // A silent sink keeps the processor running without playing the microphone back.
  const mute = context.createGain()
  mute.gain.value = 0
  processor.onaudioprocess = (event) => {
    const samples = new Float32Array(event.inputBuffer.getChannelData(0))
    let sum = 0
    for (const v of samples) sum += v * v
    onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 8))
    onChunk(samples)
  }
  source.connect(processor)
  processor.connect(mute)
  mute.connect(context.destination)
  return {
    stop() {
      processor.onaudioprocess = null
      source.disconnect()
      processor.disconnect()
      for (const track of stream.getTracks()) track.stop()
      void context.close()
    }
  }
}
