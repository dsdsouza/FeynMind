import { DEFAULT_SPEECH_MODEL, SPEECH_MODEL_IDS, type DictationStatus, type SpeechModelId, type SpeechModelState, type SpeedCheckResult } from '../../shared/dictation'
import { ensureModel, isModelReady, modelFolder, totalSize, type FetchFn } from '../ingestion'
import { UserFacingError } from '../providers'
import { cleanTranscript, MAX_RECORDING_SECONDS } from './audio'
import { SAMPLE_RATE } from './mel'
import { SPEECH_MODELS } from './models'
import type { DictationToMain, MainToDictation } from './protocol'
import { Segmenter } from './segmenter'
import { readWav } from './wav'

const RESTART_DELAYS_MS = [1_000, 5_000, 30_000]
const SETTING = 'dictation.model'
/** The renderer sends audio in small chunks; anything far larger is not from the recorder. */
const MAX_CHUNK_SAMPLES = 10 * SAMPLE_RATE

/** The dictation process as the service sees it: a utility process in the app, a fake in tests. */
export interface DictationWorker {
  postMessage(message: MainToDictation): void
  onMessage(listener: (message: DictationToMain) => void): void
  onExit(listener: (code: number) => void): void
  kill(): void
}

export interface DictationServiceOptions {
  modelsDir: string
  settings: { get(key: string): string | null; set(key: string, value: string): void }
  fetch: FetchFn
  /** False in tests that must stay offline: a model is used only if already on disk. */
  allowDownload: boolean
  spawn: () => DictationWorker
  onStatus: (status: DictationStatus) => void
  /** Records an unexpected exit of the dictation process in the exit log. */
  recordExit: (message: string) => void
  /** The speech clip the speed check transcribes. */
  speedClipPath: string
  platform: NodeJS.Platform
  /** Waits before restarting a crashed process; replaced in tests. */
  delay?: (ms: number) => Promise<void>
}

interface Job {
  audio: Float32Array
  previousText: string
  attempts: number
  resolve: (text: string) => void
  reject: (error: Error) => void
}

interface Recording {
  segmenter: Segmenter
  texts: string[]
  /** Segments are transcribed one after another, each with the text before it as context. */
  chain: Promise<void>
  samples: number
  error: Error | null
  cancelled: boolean
}

/**
 * Local speech recognition for the lesson screen. Recognition runs in a separate process that is
 * started on first use and restarted after a crash (an interrupted segment is tried once more).
 * Recordings arrive as audio chunks; they are cut into segments at pauses and transcribed while the
 * learner is still speaking, so after stop only the last segment is left. Audio stays in memory and
 * is dropped as soon as it is transcribed.
 */
export class DictationService {
  private worker: DictationWorker | null = null
  private loadedModel: string | null = null
  private loading: { modelId: string; promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } | null = null
  private readonly jobs = new Map<number, Job>()
  private readonly recordings = new Map<number, Recording>()
  private readonly models = new Map<SpeechModelId, SpeechModelState>()
  private download: { id: SpeechModelId; abort: AbortController } | null = null
  private nextId = 1
  private restarts = 0
  private engine: DictationStatus['engine'] = 'idle'
  private lastExit: DictationStatus['lastExit'] = null
  private stopping = false
  private readonly delay: (ms: number) => Promise<void>

  constructor(private readonly options: DictationServiceOptions) {
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    for (const id of SPEECH_MODEL_IDS) this.models.set(id, { id, state: 'missing', receivedBytes: 0, totalBytes: totalSize(SPEECH_MODELS[id]), error: null })
  }

  /** Checks which models are already downloaded (and intact). */
  async start(): Promise<void> {
    for (const id of SPEECH_MODEL_IDS) {
      if (await isModelReady(this.options.modelsDir, SPEECH_MODELS[id])) this.setModel(id, { state: 'ready' })
    }
    this.emit()
  }

  status(): DictationStatus {
    const p = this.options.platform
    return {
      selected: this.selected(),
      models: SPEECH_MODEL_IDS.map((id) => this.models.get(id) as SpeechModelState),
      engine: this.engine,
      lastExit: this.lastExit,
      platform: p === 'win32' || p === 'darwin' || p === 'linux' ? p : 'other',
      downloadsAllowed: this.options.allowDownload
    }
  }

  selectModel(id: SpeechModelId): DictationStatus {
    if (!SPEECH_MODEL_IDS.includes(id)) throw new UserFacingError('Unknown speech model.')
    this.options.settings.set(SETTING, id)
    this.emit()
    return this.status()
  }

  /** Downloads a model (pinned revision, checked file by file), reporting progress as status events. */
  async downloadModel(id: SpeechModelId): Promise<DictationStatus> {
    if (!SPEECH_MODEL_IDS.includes(id)) throw new UserFacingError('Unknown speech model.')
    if (!this.options.allowDownload) throw new UserFacingError('Model downloads are turned off.')
    if (this.models.get(id)?.state === 'ready') return this.status()
    if (this.download) throw new UserFacingError('A speech model is already downloading.')
    const abort = new AbortController()
    this.download = { id, abort }
    this.setModel(id, { state: 'downloading', receivedBytes: 0, error: null })
    this.emit()
    let lastEmit = 0
    try {
      await ensureModel(this.options.modelsDir, SPEECH_MODELS[id], {
        fetch: this.options.fetch,
        signal: abort.signal,
        onProgress: (p) => {
          this.setModel(id, { receivedBytes: p.receivedBytes })
          const now = Date.now()
          if (now - lastEmit > 200) {
            lastEmit = now
            this.emit()
          }
        }
      })
      this.setModel(id, { state: 'ready', receivedBytes: totalSize(SPEECH_MODELS[id]) })
    } catch (error) {
      const cancelled = abort.signal.aborted
      this.setModel(id, { state: cancelled ? 'missing' : 'error', receivedBytes: 0, error: cancelled ? null : `The download failed: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      this.download = null
      this.emit()
    }
    return this.status()
  }

  cancelDownload(): DictationStatus {
    this.download?.abort.abort()
    return this.status()
  }

  /** Starts a recording. The model is loaded meanwhile, so it is ready when the first segment is. */
  startRecording(): number {
    const model = this.selected()
    if (this.models.get(model)?.state !== 'ready') throw new UserFacingError('Download the speech model first.')
    const id = this.nextId++
    this.recordings.set(id, { segmenter: new Segmenter(), texts: [], chain: Promise.resolve(), samples: 0, error: null, cancelled: false })
    void this.ensureLoaded().catch(() => undefined)
    return id
  }

  /** Adds recorded audio. Completed segments start transcribing at once. */
  addAudio(recordingId: number, samples: Float32Array): void {
    const rec = this.recordings.get(recordingId)
    if (!rec) throw new UserFacingError('That recording has ended.')
    if (samples.length > MAX_CHUNK_SAMPLES) throw new UserFacingError('Audio chunk too large.')
    const room = MAX_RECORDING_SECONDS * SAMPLE_RATE - rec.samples
    if (room <= 0) return
    const chunk = samples.length > room ? samples.subarray(0, room) : samples
    rec.samples += chunk.length
    for (const segment of rec.segmenter.push(chunk)) this.enqueue(rec, segment)
  }

  /** Ends a recording and returns its text once the last segment is transcribed. */
  async stopRecording(recordingId: number): Promise<{ text: string }> {
    const rec = this.recordings.get(recordingId)
    if (!rec) throw new UserFacingError('That recording has ended.')
    this.enqueue(rec, rec.segmenter.flush())
    try {
      await rec.chain
      if (rec.error) throw rec.error
      return { text: cleanTranscript(rec.texts) }
    } finally {
      this.recordings.delete(recordingId)
    }
  }

  /** Drops a recording and whatever it has not transcribed yet. */
  cancelRecording(recordingId: number): void {
    const rec = this.recordings.get(recordingId)
    if (rec) rec.cancelled = true
    this.recordings.delete(recordingId)
  }

  /** Transcribes the bundled half-minute clip with the selected model and says how long it took. */
  async speedCheck(): Promise<SpeedCheckResult> {
    const model = this.selected()
    if (this.models.get(model)?.state !== 'ready') throw new UserFacingError('Download the speech model first.')
    const { samples } = readWav(this.options.speedClipPath)
    await this.ensureLoaded()
    const started = performance.now()
    const text = await this.transcribe(samples, '')
    return { model, audioSeconds: Math.round((samples.length / SAMPLE_RATE) * 10) / 10, seconds: Math.round((performance.now() - started) / 100) / 10, text }
  }

  async stop(timeoutMs = 3_000): Promise<void> {
    this.stopping = true
    this.download?.abort.abort()
    const worker = this.worker
    if (!worker) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        worker.kill()
        resolve()
      }, timeoutMs)
      worker.onExit(() => {
        clearTimeout(timer)
        resolve()
      })
      worker.postMessage({ type: 'shutdown' })
    })
  }

  // Recording internals

  private enqueue(rec: Recording, segment: Float32Array): void {
    rec.chain = rec.chain.then(async () => {
      if (rec.cancelled || rec.error || segment.length === 0) return
      try {
        rec.texts.push(await this.transcribe(segment, rec.texts.join(' ')))
      } catch (error) {
        rec.error = error instanceof Error ? error : new Error(String(error))
      }
    })
  }

  private async transcribe(audio: Float32Array, previousText: string): Promise<string> {
    await this.ensureLoaded()
    const id = this.nextId++
    return new Promise<string>((resolve, reject) => {
      this.jobs.set(id, { audio, previousText, attempts: 1, resolve, reject })
      this.worker?.postMessage({ type: 'transcribe', id, audio, previousText })
    })
  }

  // Process management

  private selected(): SpeechModelId {
    const value = this.options.settings.get(SETTING)
    return value !== null && (SPEECH_MODEL_IDS as readonly string[]).includes(value) ? (value as SpeechModelId) : DEFAULT_SPEECH_MODEL
  }

  private ensureLoaded(): Promise<void> {
    const modelId = this.selected()
    if (this.worker && this.loadedModel === SPEECH_MODELS[modelId].id) return Promise.resolve()
    if (this.loading?.modelId === SPEECH_MODELS[modelId].id) return this.loading.promise
    if (!this.worker) this.spawn()
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    this.loading = { modelId: SPEECH_MODELS[modelId].id, promise, resolve, reject }
    this.setEngine('loading')
    this.worker?.postMessage({ type: 'load', modelId: SPEECH_MODELS[modelId].id, modelDir: modelFolder(this.options.modelsDir, SPEECH_MODELS[modelId]) })
    return promise
  }

  private spawn(): void {
    const worker = this.options.spawn()
    this.worker = worker
    this.loadedModel = null
    worker.onMessage((message) => this.handle(message))
    worker.onExit((code) => this.onExit(worker, code))
  }

  private handle(message: DictationToMain): void {
    switch (message.type) {
      case 'loaded':
        this.loadedModel = message.modelId
        if (this.loading?.modelId === message.modelId) {
          this.loading.resolve()
          this.loading = null
        }
        this.setEngine('ready')
        return
      case 'loadFailed':
        if (this.loading?.modelId === message.modelId) {
          this.loading.reject(new UserFacingError(`The speech model could not be loaded: ${message.error}`))
          this.loading = null
        }
        this.setEngine('idle')
        return
      case 'result':
      case 'failed': {
        const job = this.jobs.get(message.id)
        if (!job) return
        this.jobs.delete(message.id)
        this.restarts = 0
        if (message.type === 'result') job.resolve(message.text)
        else job.reject(new UserFacingError(`Transcription failed: ${message.error}`))
      }
    }
  }

  /**
   * The process went away. A crash is logged and the process restarted after 1, 5, then 30 s; a
   * transcription that was interrupted is sent once more, and fails with a clear message after that.
   */
  private onExit(worker: DictationWorker, code: number): void {
    if (this.worker !== worker) return
    this.worker = null
    this.loadedModel = null
    if (this.stopping) return
    const loading = this.loading
    this.loading = null
    const count = (this.lastExit?.count ?? 0) + 1
    this.lastExit = { code, at: new Date().toISOString(), count }
    const delay = RESTART_DELAYS_MS[Math.min(this.restarts, RESTART_DELAYS_MS.length - 1)] ?? 30_000
    this.restarts++
    this.options.recordExit(`Dictation process exited unexpectedly with code ${code}; restarting in ${delay / 1000} s (unexpected exit ${count} this session).`)
    this.setEngine('restarting')
    const retry: Job[] = []
    for (const [id, job] of this.jobs) {
      this.jobs.delete(id)
      if (job.attempts < 2) retry.push(job)
      else job.reject(new UserFacingError('Speech recognition stopped unexpectedly. Please record that part again.'))
    }
    // A model that takes the process down whenever it loads would restart forever: give up.
    if (this.restarts > RESTART_DELAYS_MS.length) {
      const failure = new UserFacingError('Speech recognition keeps stopping. Try a smaller speech model in Settings, or type or use your system dictation instead.')
      loading?.reject(failure)
      for (const job of retry) job.reject(failure)
      this.setEngine('idle')
      return
    }
    if (retry.length === 0 && !loading) {
      this.setEngine('idle')
      return
    }
    void this.delay(delay).then(async () => {
      if (this.stopping) return
      try {
        await this.ensureLoaded()
        loading?.resolve()
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        loading?.reject(failure)
        for (const job of retry) job.reject(failure)
        return
      }
      for (const job of retry) {
        const id = this.nextId++
        this.jobs.set(id, { ...job, attempts: job.attempts + 1 })
        this.worker?.postMessage({ type: 'transcribe', id, audio: job.audio, previousText: job.previousText })
      }
    })
  }

  private setModel(id: SpeechModelId, change: Partial<SpeechModelState>): void {
    this.models.set(id, { ...(this.models.get(id) as SpeechModelState), ...change })
  }

  private setEngine(state: DictationStatus['engine']): void {
    this.engine = state
    this.emit()
  }

  private emit(): void {
    this.options.onStatus(this.status())
  }
}
