// Messages between the main process (service.ts) and the dictation process (worker.ts). Audio is
// passed in memory only.

export type MainToDictation =
  | { type: 'load'; modelId: string; modelDir: string }
  | { type: 'transcribe'; id: number; audio: Float32Array; previousText: string }
  | { type: 'shutdown' }

export type DictationToMain =
  | { type: 'loaded'; modelId: string }
  | { type: 'loadFailed'; modelId: string; error: string }
  | { type: 'result'; id: number; text: string; ms: number }
  | { type: 'failed'; id: number; error: string }
