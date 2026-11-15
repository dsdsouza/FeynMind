import { useState } from 'react'
import { SPEECH_MODEL_CHOICES, type SpeechModelId, type SpeechModelState, type SpeedCheckResult } from '../../../shared/dictation'
import { useDictationStatus } from '../dictation'
import { api, messageOf, unwrap } from '../lib'
import { OsDictationHint } from './Dictation'

const mb = (bytes: number) => Math.round(bytes / 1_000_000)

/** Settings › Dictation: which speech model to use, downloading it, and how fast it is here. */
export function DictationSettings() {
  const status = useDictationStatus()
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [speed, setSpeed] = useState<SpeedCheckResult | null>(null)
  if (!status) return null
  const selected = status.models.find((m) => m.id === status.selected)

  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    setError(null)
    try {
      return await action()
    } catch (e) {
      setError(messageOf(e))
      return null
    }
  }

  async function check() {
    setChecking(true)
    setSpeed(null)
    const result = await run(async () => unwrap(await api['dictation:speedCheck']()))
    if (result) setSpeed(result)
    setChecking(false)
  }

  return (
    <section className="card" aria-labelledby="dictation-title">
      <h2 id="dictation-title">Dictation</h2>
      <p className="muted">
        The microphone buttons in lessons turn your speech into text on this computer. Audio is never saved and never sent anywhere; only the text you submit is used. English only.
      </p>
      <fieldset className="speech-models">
        <legend>Speech model</legend>
        {SPEECH_MODEL_CHOICES.map((choice) => {
          const model = status.models.find((m) => m.id === choice.id) as SpeechModelState
          return (
            <div key={choice.id} className="speech-model" data-testid={`speech-model-${choice.id}`}>
              <label>
                <input
                  type="radio"
                  name="speech-model"
                  checked={status.selected === choice.id}
                  onChange={() => {
                    setSpeed(null)
                    void run(async () => unwrap(await api['dictation:selectModel']({ model: choice.id })))
                  }}
                />{' '}
                <strong>{choice.label}</strong> <span className="muted">· {mb(choice.bytes)} MB download</span>
              </label>
              <p className="muted">{choice.note}</p>
              <ModelLine model={model} id={choice.id} allowed={status.downloadsAllowed} run={run} />
            </div>
          )
        })}
      </fieldset>
      <div className="row">
        <button type="button" onClick={() => void check()} disabled={checking || selected?.state !== 'ready'}>
          {checking ? 'Checking…' : 'Check speed on this computer'}
        </button>
        {selected?.state !== 'ready' && <span className="muted">Download the selected model first.</span>}
      </div>
      {speed && (
        <p role="status" data-testid="speed-result">
          {SPEECH_MODEL_CHOICES.find((c) => c.id === speed.model)?.label.replace(' (recommended)', '')} took <strong>{speed.seconds.toFixed(1)} s</strong> to transcribe {speed.audioSeconds} s of speech.{' '}
          {speed.seconds > speed.audioSeconds / 2
            ? 'That may feel slow; a smaller model will be quicker.'
            : 'While you speak, most of this happens in the background, so after you stop you wait only for the last few seconds.'}{' '}
          A laptop on battery is often two to three times slower.
          <br />
          <span className="muted">
            It heard: “{speed.text}” (a reading from a public-domain book; LibriSpeech, CC BY 4.0).
          </span>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <OsDictationHint platform={status.platform} />
    </section>
  )
}

function ModelLine({ model, id, allowed, run }: { model: SpeechModelState; id: SpeechModelId; allowed: boolean; run: <T>(a: () => Promise<T>) => Promise<T | null> }) {
  if (model.state === 'ready') return <p className="muted">Downloaded.</p>
  if (model.state === 'checking') return <p className="muted">Checking…</p>
  if (model.state === 'downloading')
    return (
      <div>
        <progress max={model.totalBytes} value={model.receivedBytes} aria-label={`Downloading ${id}`} /> {mb(model.receivedBytes)} of {mb(model.totalBytes)} MB{' '}
        <button type="button" className="secondary" onClick={() => void run(async () => unwrap(await api['dictation:cancelDownload']()))}>
          Cancel
        </button>
      </div>
    )
  return (
    <div>
      {model.error && <p className="error">{model.error}</p>}
      <button type="button" className="secondary" disabled={!allowed} onClick={() => void run(async () => unwrap(await api['dictation:download']({ model: id })))}>
        Download
      </button>
      {!allowed && <span className="muted"> Downloads are turned off.</span>}
    </div>
  )
}
