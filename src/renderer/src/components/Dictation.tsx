import { useState } from 'react'
import { SPEECH_MODEL_CHOICES, type DictationStatus } from '../../../shared/dictation'
import { DICTATION_SHORTCUT, type DictationPhase } from '../dictation'
import { api } from '../lib'

export function MicButton({ label, active, disabled, onClick }: { label: string; active: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className={active ? 'mic mic-on' : 'mic'} aria-pressed={active} disabled={disabled} onClick={onClick} title={`${active ? 'Stop' : 'Dictate'} (${DICTATION_SHORTCUT})`}>
      <span aria-hidden="true">{active ? '■' : '🎤'}</span> {active ? `Stop` : `Dictate ${label}`}
    </button>
  )
}

const minutes = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/** "Listening 0:12" with a level meter, then "Transcribing…": always visible while active. */
export function DictationState({ phase, seconds, level, onStop, onCancel }: { phase: DictationPhase; seconds: number; level: number; onStop: () => void; onCancel: () => void }) {
  if (phase === 'idle') return null
  return (
    <div className={`dictation-state dictation-${phase}`} role="status" aria-live="polite" data-testid="dictation-state">
      {phase === 'preparing' && <span>Starting the microphone…</span>}
      {phase === 'listening' && (
        <>
          <span className="rec-dot" aria-hidden="true" /> <strong>Listening</strong> {minutes(seconds)}
          <meter className="mic-level" min={0} max={1} value={level} aria-label="Microphone level" />
          <button type="button" onClick={onStop}>
            Stop ({DICTATION_SHORTCUT})
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Discard (Esc)
          </button>
        </>
      )}
      {phase === 'transcribing' && <strong>Transcribing…</strong>}
    </div>
  )
}

/** Shown when the microphone is pressed before a speech model is on this computer. */
export function ModelPrompt({ status, onClose }: { status: DictationStatus; onClose: () => void }) {
  const model = status.models.find((m) => m.id === status.selected)
  const choice = SPEECH_MODEL_CHOICES.find((c) => c.id === status.selected)
  const [error, setError] = useState<string | null>(null)
  if (!model || !choice) return null
  const mb = (b: number) => Math.round(b / 1_000_000)
  return (
    <div className="card model-prompt" role="region" aria-label="Speech model" data-testid="model-prompt">
      {model.state === 'ready' ? (
        <p>
          The speech model is ready. Press the microphone again to dictate.{' '}
          <button type="button" className="link" onClick={onClose}>
            Close
          </button>
        </p>
      ) : model.state === 'checking' ? (
        <p>Checking for the speech model on this computer…</p>
      ) : model.state === 'downloading' ? (
        <>
          <p>
            Downloading the speech model… {mb(model.receivedBytes)} of {mb(model.totalBytes)} MB
          </p>
          <progress max={model.totalBytes} value={model.receivedBytes} aria-label="Speech model download" />
          <button type="button" className="secondary" onClick={() => void api['dictation:cancelDownload']()}>
            Cancel download
          </button>
        </>
      ) : (
        <>
          <p>
            Dictation turns speech into text on this computer. It needs a speech model, downloaded once: {choice.label.replace(' (recommended)', '')}, {mb(model.totalBytes)} MB. You can choose a
            larger, more accurate one in Settings.
          </p>
          {model.error && <p className="error">{model.error}</p>}
          {error && <p className="error">{error}</p>}
          {!status.downloadsAllowed && <p className="warning">Model downloads are turned off.</p>}
          <div className="row">
            <button
              type="button"
              disabled={!status.downloadsAllowed}
              onClick={() =>
                void api['dictation:download']({ model: status.selected }).then((r) => {
                  if (!r.ok) setError(r.error)
                })
              }
            >
              Download ({mb(model.totalBytes)} MB)
            </button>
            <button type="button" className="secondary" onClick={onClose}>
              Not now
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** The operating system's own dictation, as an equal alternative. Nothing on Linux. */
export function OsDictationHint({ platform }: { platform: DictationStatus['platform'] }) {
  if (platform === 'win32') return <p className="muted os-hint">Or use Windows dictation: press Windows key + H in a field.</p>
  if (platform === 'darwin') return <p className="muted os-hint">Or use macOS Dictation: Edit › Start Dictation, or its keyboard shortcut.</p>
  return null
}
