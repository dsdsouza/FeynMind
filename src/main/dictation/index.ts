// The dictation module: local speech recognition with Whisper. Other modules use only what is
// exported here.
export { DictationService, type DictationServiceOptions, type DictationWorker } from './service'
export type { DictationToMain, MainToDictation } from './protocol'
