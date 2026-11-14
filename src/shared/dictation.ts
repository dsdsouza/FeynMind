// Types for dictation, shared by the background process and the interface.

export type SpeechModelId = 'tiny.en' | 'base.en' | 'small.en'

export const DEFAULT_SPEECH_MODEL: SpeechModelId = 'base.en'

/** What Settings shows for each speech model. Sizes are the download, in bytes. */
export const SPEECH_MODEL_CHOICES: { id: SpeechModelId; label: string; bytes: number; note: string }[] = [
  { id: 'tiny.en', label: 'Tiny', bytes: 43_536_035, note: 'Fastest. Fine on older laptops, but mishears more words.' },
  { id: 'base.en', label: 'Base (recommended)', bytes: 79_586_217, note: 'A good balance of speed and accuracy on most computers.' },
  { id: 'small.en', label: 'Small', bytes: 251_768_746, note: 'Most accurate, and noticeably slower: several seconds per half-minute of speech on a typical laptop.' }
]
