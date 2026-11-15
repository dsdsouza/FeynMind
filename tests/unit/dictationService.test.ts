import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DictationStatus } from '../../src/shared/dictation'
import { DictationService, type DictationToMain, type DictationWorker, type MainToDictation } from '../../src/main/dictation'
import { SAMPLE_RATE } from '../../src/main/dictation/mel'
import { SPEECH_MODELS } from '../../src/main/dictation/models'
import { modelFolder } from '../../src/main/ingestion/modelStore'

const FIXTURE_CLIP = join(import.meta.dirname, '..', 'fixtures', 'audio', 'speech-9s.wav')

/**
 * A dictation process in memory. It "transcribes" a segment as its length in tenths of a second
 * ("t92"), so tests can see which audio went where. crashOn makes it exit instead of answering.
 */
class FakeWorker implements DictationWorker {
  static spawned: FakeWorker[] = []
  readonly received: MainToDictation[] = []
  crashNext = 0
  private message: (m: DictationToMain) => void = () => undefined
  private exit: ((code: number) => void)[] = []
  constructor() {
    FakeWorker.spawned.push(this)
  }
  postMessage(m: MainToDictation): void {
    this.received.push(m)
    queueMicrotask(() => {
      if (m.type === 'shutdown') return this.exit.forEach((l) => l(0))
      if (m.type === 'transcribe' && this.crashNext > 0) {
        this.crashNext--
        return this.exit.forEach((l) => l(3221225477))
      }
      if (m.type === 'load') this.message({ type: 'loaded', modelId: m.modelId })
      else if (m.type === 'transcribe') this.message({ type: 'result', id: m.id, text: `t${Math.round((m.audio.length / SAMPLE_RATE) * 10)}`, ms: 1 })
    })
  }
  onMessage(l: (m: DictationToMain) => void): void {
    this.message = l
  }
  onExit(l: (code: number) => void): void {
    this.exit.push(l)
  }
  kill(): void {
    this.exit.forEach((l) => l(1))
  }
}

/** Writes files that pass for a downloaded model (checked by size and SHA-256, so only the folder layout is faked here). */
function setup(options: { allowDownload?: boolean } = {}) {
  FakeWorker.spawned = []
  const modelsDir = mkdtempSync(join(tmpdir(), 'feynmind-dictation-'))
  const settings = new Map<string, string>()
  const statuses: DictationStatus[] = []
  const exits: string[] = []
  const service = new DictationService({
    modelsDir,
    settings: { get: (k) => settings.get(k) ?? null, set: (k, v) => void settings.set(k, v) },
    fetch: async () => new Response(null, { status: 404 }),
    allowDownload: options.allowDownload ?? false,
    spawn: () => new FakeWorker(),
    onStatus: (s) => statuses.push(s),
    recordExit: (m) => exits.push(m),
    speedClipPath: FIXTURE_CLIP,
    platform: 'win32',
    delay: async () => undefined
  })
  return { service, modelsDir, settings, statuses, exits }
}

/** Marks the default model ready without downloading it (the service trusts its own check). */
function markReady(service: DictationService): void {
  ;(service as unknown as { setModel: (id: string, c: object) => void }).setModel('tiny.en', { state: 'ready' })
}

const speech = (seconds: number) => Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, i) => 0.2 * Math.sin(i / 7))
const pause = (seconds: number) => new Float32Array(seconds * SAMPLE_RATE)
/** Sends audio as the recorder does, in quarter-second chunks. */
function send(service: DictationService, id: number, ...parts: Float32Array[]): void {
  for (const part of parts) for (let i = 0; i < part.length; i += SAMPLE_RATE / 4) service.addAudio(id, part.subarray(i, i + SAMPLE_RATE / 4))
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('dictation service', () => {
  it('defaults to tiny, reports models as missing until downloaded, and refuses to record without a model', async () => {
    const { service } = setup()
    await service.start()
    expect(service.status()).toMatchObject({ selected: 'tiny.en', engine: 'idle', platform: 'win32', downloadsAllowed: false })
    expect(service.status().models.map((m) => [m.id, m.state])).toEqual([['tiny.en', 'missing'], ['base.en', 'missing'], ['small.en', 'missing']])
    expect(() => service.startRecording()).toThrow('Download the speech model first')
    await expect(service.downloadModel('tiny.en')).rejects.toThrow('downloads are turned off')
  })

  it('remembers the chosen model', () => {
    const { service, settings } = setup()
    expect(service.selectModel('base.en').selected).toBe('base.en')
    expect(settings.get('dictation.model')).toBe('base.en')
  })

  it('transcribes segments while recording, with the earlier text as context, and joins them at stop', async () => {
    const { service } = setup()
    markReady(service)
    const id = service.startRecording()
    send(service, id, speech(9), pause(1), speech(9), pause(1))
    await tick()
    const worker = FakeWorker.spawned[0] as FakeWorker
    // The model loads as soon as recording starts; the first segment is sent before stop.
    expect(worker.received[0]).toMatchObject({ type: 'load', modelId: SPEECH_MODELS['tiny.en'].id, modelDir: modelFolder(join(service['options'].modelsDir), SPEECH_MODELS['tiny.en']) })
    const before = worker.received.filter((m) => m.type === 'transcribe')
    expect(before.length).toBeGreaterThanOrEqual(1)
    send(service, id, speech(3))
    const { text } = await service.stopRecording(id)
    const sent = worker.received.filter((m) => m.type === 'transcribe') as Extract<MainToDictation, { type: 'transcribe' }>[]
    expect(sent.map((m) => m.previousText)).toEqual(['', 't93', 't93 t100'])
    expect(text).toBe('t93 t100 t37')
    expect(() => service.addAudio(id, speech(1))).toThrow('That recording has ended')
  })

  it('stops at five minutes of audio', async () => {
    const { service } = setup()
    markReady(service)
    const id = service.startRecording()
    for (let i = 0; i < 31; i++) send(service, id, speech(9), pause(1))
    const { text } = await service.stopRecording(id)
    const total = text.split(' ').reduce((n, t) => n + Number(t.slice(1)), 0) / 10
    expect(total).toBeCloseTo(300, 0)
  })

  it('drops a cancelled recording without transcribing the rest', async () => {
    const { service } = setup()
    markReady(service)
    const id = service.startRecording()
    send(service, id, speech(3))
    service.cancelRecording(id)
    await tick()
    expect(FakeWorker.spawned[0]?.received.filter((m) => m.type === 'transcribe')).toEqual([])
    await expect(service.stopRecording(id)).rejects.toThrow('That recording has ended')
  })

  it('after a crash, logs it, restarts the process, reloads the model and retries the segment once', async () => {
    const { service, exits, statuses } = setup()
    markReady(service)
    const id = service.startRecording()
    await tick()
    ;(FakeWorker.spawned[0] as FakeWorker).crashNext = 1
    send(service, id, speech(4))
    const { text } = await service.stopRecording(id)
    expect(text).toBe('t40')
    expect(FakeWorker.spawned).toHaveLength(2)
    expect(FakeWorker.spawned[1]?.received.map((m) => m.type)).toEqual(['load', 'transcribe'])
    expect(exits[0]).toMatch(/Dictation process exited unexpectedly with code 3221225477; restarting in 1 s/)
    expect(statuses.some((s) => s.engine === 'restarting')).toBe(true)
    expect(service.status()).toMatchObject({ engine: 'ready', lastExit: { code: 3221225477, count: 1 } })
  })

  it('gives up on a segment that crashes the process twice, with a clear message', async () => {
    const { service } = setup()
    markReady(service)
    const id = service.startRecording()
    await tick()
    const original = service['options'].spawn
    service['options'].spawn = () => {
      const w = original() as FakeWorker
      w.crashNext = 1
      return w
    }
    ;(FakeWorker.spawned[0] as FakeWorker).crashNext = 1
    send(service, id, speech(4))
    await expect(service.stopRecording(id)).rejects.toThrow('Please record that part again')
  })

  it('times the speed check on the bundled clip with the selected model', async () => {
    const { service } = setup()
    markReady(service)
    const result = await service.speedCheck()
    expect(result).toMatchObject({ model: 'tiny.en', audioSeconds: 9.2, text: 't92' })
    expect(result.seconds).toBeGreaterThanOrEqual(0)
  })

  it('finds models already on disk at start (checked by checksum)', async () => {
    const { service, modelsDir } = setup()
    const folder = modelFolder(modelsDir, SPEECH_MODELS['tiny.en'])
    mkdirSync(join(folder, 'onnx'), { recursive: true })
    writeFileSync(join(folder, 'config.json'), 'not the real file')
    await service.start()
    // A damaged or partial model is not ready.
    expect(service.status().models[0]?.state).toBe('missing')
  })

  it('reports a failed download and lets it be tried again', async () => {
    const { service } = setup({ allowDownload: true })
    const status = await service.downloadModel('tiny.en')
    expect(status.models[0]).toMatchObject({ state: 'error' })
    expect(status.models[0]?.error).toContain('The download failed')
  })
})
