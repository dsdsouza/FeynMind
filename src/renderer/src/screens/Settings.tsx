import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { KeySource, ModelInfo, ProviderSettingsState, Result, TestResult } from '../../../shared/ipc'
import type { UsageSummary } from '../../../shared/knowledge'

const api = window.feynmind

type Status<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; value: T }

const KEY_SOURCE_TEXT: Record<KeySource, string> = {
  stored: 'A key is saved in your system’s secure storage.',
  env: 'Using GEMINI_API_KEY from .env.local (development only). Save a key to use it in builds.',
  none: 'No key yet. Get one from Google AI Studio and paste it below.'
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

export function Settings() {
  const [state, setState] = useState<ProviderSettingsState | null>(null)
  const [stateError, setStateError] = useState<string | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [keyStatus, setKeyStatus] = useState<Status<null>>({ kind: 'idle' })
  const [models, setModels] = useState<Status<ModelInfo[]>>({ kind: 'idle' })
  const [test, setTest] = useState<Status<TestResult>>({ kind: 'idle' })

  const loadModels = useCallback(async () => {
    setModels({ kind: 'loading' })
    try {
      const list = unwrap(await api['provider:listModels']())
      setModels({ kind: 'done', value: list })
      // Listing may pre-select a default model, so refresh the state.
      setState(unwrap(await api['settings:getState']()))
    } catch (error) {
      setModels({ kind: 'error', message: messageOf(error) })
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const initial = unwrap(await api['settings:getState']())
        if (cancelled) return
        setState(initial)
        if (initial.keySource !== 'none') await loadModels()
      } catch (error) {
        if (!cancelled) setStateError(messageOf(error))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadModels])

  async function saveKey(event: FormEvent) {
    event.preventDefault()
    setKeyStatus({ kind: 'loading' })
    try {
      setState(unwrap(await api['settings:saveKey']({ apiKey: keyInput })))
      setKeyInput('')
      setKeyStatus({ kind: 'done', value: null })
      setTest({ kind: 'idle' })
      await loadModels()
    } catch (error) {
      setKeyStatus({ kind: 'error', message: messageOf(error) })
    }
  }

  async function clearKey() {
    try {
      const next = unwrap(await api['settings:clearKey']())
      setState(next)
      setKeyStatus({ kind: 'idle' })
      setTest({ kind: 'idle' })
      if (next.keySource === 'none') setModels({ kind: 'idle' })
      else await loadModels()
    } catch (error) {
      setKeyStatus({ kind: 'error', message: messageOf(error) })
    }
  }

  async function selectModel(modelId: string) {
    try {
      setState(unwrap(await api['settings:selectModel']({ modelId })))
      setTest({ kind: 'idle' })
    } catch (error) {
      setModels({ kind: 'error', message: messageOf(error) })
    }
  }

  async function runTest() {
    setTest({ kind: 'loading' })
    try {
      setTest({ kind: 'done', value: unwrap(await api['provider:test']()) })
    } catch (error) {
      setTest({ kind: 'error', message: messageOf(error) })
    }
  }

  if (stateError) {
    return (
      <section className="screen">
        <h1>Settings</h1>
        <p className="error" role="alert">
          Could not load settings: {stateError}
        </p>
      </section>
    )
  }

  if (!state) {
    return (
      <section className="screen">
        <h1>Settings</h1>
        <p className="muted">Loading…</p>
      </section>
    )
  }

  const modelList = models.kind === 'done' ? models.value : []
  const selectedIsListed = modelList.some((m) => m.id === state.selectedModel)

  return (
    <section className="screen" aria-labelledby="settings-title">
      <h1 id="settings-title">Settings</h1>

      <div className="card">
        <h2>Gemini (Google)</h2>
        <p className="muted" data-testid="key-source">
          {KEY_SOURCE_TEXT[state.keySource]}
        </p>

        {!state.canStoreKey && (
          <p className="warning" role="status">
            Secure storage is not available on this system, so a key cannot be saved here.
          </p>
        )}

        <form className="row" onSubmit={(e) => void saveKey(e)}>
          <label htmlFor="api-key" className="visually-hidden">
            Gemini API key
          </label>
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={state.keySource === 'stored' ? 'Paste a new key to replace the saved one' : 'Paste your Gemini API key'}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            disabled={!state.canStoreKey || keyStatus.kind === 'loading'}
          />
          <button type="submit" disabled={!state.canStoreKey || keyInput.trim() === '' || keyStatus.kind === 'loading'}>
            {keyStatus.kind === 'loading' ? 'Saving…' : 'Save key'}
          </button>
          {state.keySource === 'stored' && (
            <button type="button" className="secondary" onClick={() => void clearKey()}>
              Remove saved key
            </button>
          )}
        </form>
        {keyStatus.kind === 'done' && <p className="success" role="status">Key saved.</p>}
        {keyStatus.kind === 'error' && <p className="error" role="alert">{keyStatus.message}</p>}
      </div>

      <div className="card">
        <h2>Model</h2>
        {state.keySource === 'none' ? (
          <p className="muted">Add a key to see the models it can reach.</p>
        ) : (
          <>
            <div className="row">
              <label htmlFor="model">Model</label>
              <select
                id="model"
                value={selectedIsListed ? (state.selectedModel ?? '') : ''}
                onChange={(e) => void selectModel(e.target.value)}
                disabled={models.kind !== 'done' || modelList.length === 0}
              >
                {!selectedIsListed && <option value="">{models.kind === 'loading' ? 'Loading models…' : 'Choose a model'}</option>}
                {modelList.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName === m.id ? m.id : `${m.displayName} (${m.id})`}
                  </option>
                ))}
              </select>
              <button type="button" className="secondary" onClick={() => void loadModels()} disabled={models.kind === 'loading'}>
                Refresh
              </button>
            </div>
            {models.kind === 'done' && (
              <p className="muted" data-testid="model-count">
                {modelList.length} text model{modelList.length === 1 ? '' : 's'} available for this key.
              </p>
            )}
            {models.kind === 'error' && <p className="error" role="alert">{models.message}</p>}
          </>
        )}
      </div>

      <div className="card">
        <h2>Test connection</h2>
        <p className="muted">Sends one short prompt to the selected model.</p>
        <button
          type="button"
          onClick={() => void runTest()}
          disabled={state.keySource === 'none' || !state.selectedModel || test.kind === 'loading'}
        >
          {test.kind === 'loading' ? 'Testing…' : 'Test'}
        </button>
        <div aria-live="polite">
          {test.kind === 'done' && (
            <div className="reply" data-testid="test-reply">
              <p>{test.value.reply || '(The model returned an empty reply.)'}</p>
              <p className="muted">
                {test.value.model} · {(test.value.elapsedMs / 1000).toFixed(1)} s
              </p>
            </div>
          )}
          {test.kind === 'error' && <p className="error" role="alert">{test.message}</p>}
        </div>
      </div>

      <UsageLimits selectedModel={state.selectedModel} />
    </section>
  )
}

/** Caps on model use for the course session, the request pace, and the price used for dollar amounts. */
function UsageLimits({ selectedModel }: { selectedModel: string | null }) {
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [form, setForm] = useState({ callCap: '', spendCap: '', rpm: '', priceIn: '', priceOut: '' })
  const [status, setStatus] = useState<Status<null>>({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const session = unwrap(await api['sessions:current']())
        const u = unwrap(await api['usage:get']({ sessionId: session.id }))
        if (cancelled) return
        setUsage(u)
        setForm({
          callCap: u.callCap === null ? '' : String(u.callCap),
          spendCap: u.spendCapUsd === null ? '' : String(u.spendCapUsd),
          rpm: String(u.requestsPerMinute),
          priceIn: u.price?.source === 'user' ? String(u.price.inputPerMillion) : '',
          priceOut: u.price?.source === 'user' ? String(u.price.outputPerMillion) : ''
        })
      } catch (error) {
        if (!cancelled) setStatus({ kind: 'error', message: messageOf(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedModel])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!usage) return
    const num = (s: string): number | null => (s.trim() === '' ? null : Number(s))
    const priceIn = num(form.priceIn)
    const priceOut = num(form.priceOut)
    setStatus({ kind: 'loading' })
    try {
      const next = unwrap(
        await api['usage:setLimits']({
          sessionId: usage.sessionId,
          callCap: num(form.callCap),
          spendCapUsd: num(form.spendCap),
          requestsPerMinute: Number(form.rpm),
          price: priceIn !== null && priceOut !== null ? { input: priceIn, output: priceOut } : null
        })
      )
      setUsage(next)
      setStatus({ kind: 'done', value: null })
    } catch (error) {
      setStatus({ kind: 'error', message: messageOf(error) })
    }
  }

  if (!usage) return status.kind === 'error' ? <p className="error">{status.message}</p> : null
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }))
  return (
    <form className="card" onSubmit={(e) => void save(e)} aria-labelledby="limits-title">
      <h2 id="limits-title">Usage limits</h2>
      <p className="muted">
        This course has used {usage.calls} model calls ({usage.requests} requests including refused ones, {usage.cacheHits} answered from the cache).
      </p>
      <label htmlFor="call-cap">Call cap for this course (empty for none)</label>
      <input id="call-cap" type="number" min={0} step={1} value={form.callCap} onChange={set('callCap')} />
      <label htmlFor="spend-cap">Spending cap in dollars (empty for none; needs a known price)</label>
      <input id="spend-cap" type="number" min={0} step="0.01" value={form.spendCap} onChange={set('spendCap')} />
      <label htmlFor="rpm">Requests per minute</label>
      <input id="rpm" type="number" min={1} step={1} value={form.rpm} onChange={set('rpm')} />
      <p className="muted">The app also waits whenever the provider says its limit is reached, and pauses a job when the daily quota runs out.</p>
      {selectedModel && (
        <>
          <p className="muted">
            Price of {selectedModel}:{' '}
            {usage.price
              ? `$${usage.price.inputPerMillion} in, $${usage.price.outputPerMillion} out per million tokens (${usage.price.source === 'user' ? 'entered by you' : `from the provider’s price list, checked ${usage.price.checked}`}).`
              : 'unknown. Enter it to see dollar amounts and use a spending cap.'}
          </p>
          <div className="row">
            <label>
              Your price in ($/M tokens)
              <input type="number" min={0} step="0.001" value={form.priceIn} onChange={set('priceIn')} />
            </label>
            <label>
              Your price out ($/M tokens)
              <input type="number" min={0} step="0.001" value={form.priceOut} onChange={set('priceOut')} />
            </label>
          </div>
        </>
      )}
      <button type="submit" disabled={status.kind === 'loading'}>
        Save limits
      </button>
      {status.kind === 'done' && <p className="success">Saved.</p>}
      {status.kind === 'error' && (
        <p className="error" role="alert">
          {status.message}
        </p>
      )}
    </form>
  )
}
