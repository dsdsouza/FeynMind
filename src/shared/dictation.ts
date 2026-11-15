// Types for dictation, shared by the background process and the interface.

export type SpeechModelId = 'tiny.en' | 'base.en' | 'small.en'

export const DEFAULT_SPEECH_MODEL: SpeechModelId = 'tiny.en'

export const SPEECH_MODEL_IDS: readonly SpeechModelId[] = ['tiny.en', 'base.en', 'small.en']

/** What Settings shows for each speech model. Sizes are the download, in bytes. */
export const SPEECH_MODEL_CHOICES: { id: SpeechModelId; label: string; bytes: number; note: string }[] = [
  { id: 'tiny.en', label: 'Tiny (recommended)', bytes: 43_536_035, note: 'Fast on most computers, also on battery. Mishears more words than the larger models.' },
  { id: 'base.en', label: 'Base', bytes: 79_586_217, note: 'More accurate, about three times slower than tiny. Can be slow on battery.' },
  { id: 'small.en', label: 'Small', bytes: 251_768_746, note: 'Most accurate and much slower: about six times slower than tiny. For fast computers on mains power.' }
]

export interface SpeechModelState {
  id: SpeechModelId
  state: 'missing' | 'downloading' | 'ready' | 'error'
  receivedBytes: number
  totalBytes: number
  error: string | null
}

export interface DictationStatus {
  selected: SpeechModelId
  models: SpeechModelState[]
  /** The recognition process: not started yet, loading a model, ready, or restarting after a crash. */
  engine: 'idle' | 'loading' | 'ready' | 'restarting'
  /** The last unexpected exit of the recognition process, if any. */
  lastExit: { code: number; at: string; count: number } | null
  /** For the operating system dictation hint. */
  platform: 'win32' | 'darwin' | 'linux' | 'other'
  /** False when model downloads are turned off (offline tests). */
  downloadsAllowed: boolean
}

export interface SpeedCheckResult {
  model: SpeechModelId
  audioSeconds: number
  seconds: number
}
