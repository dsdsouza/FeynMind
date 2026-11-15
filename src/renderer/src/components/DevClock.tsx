import { useEffect, useState } from 'react'
import type { DevClockState } from '../../../shared/reviews'
import { api, formatDay, messageOf, unwrap } from '../lib'

/**
 * Development builds only: moves the app's date forward to try several weeks of reviews in
 * minutes. Rendered only when import.meta.env.DEV is true, so production bundles leave it out,
 * and the main process refuses the request in packaged builds anyway.
 */
export function DevClock() {
  const [state, setState] = useState<DevClockState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api['dev:clock']({ action: 'get' }).then((r) => (r.ok ? setState(r.value) : setError(r.error)))
  }, [])

  async function run(request: { action: 'move' | 'reset'; days?: number }) {
    setError(null)
    try {
      setState(unwrap(await api['dev:clock'](request)))
    } catch (e) {
      setError(messageOf(e))
    }
  }

  return (
    <section className="card dev-clock" aria-labelledby="dev-clock-title" data-testid="dev-clock">
      <h2 id="dev-clock-title">Development: app date</h2>
      {state && (
        <p>
          The app thinks today is <strong>{formatDay(state.day)}</strong>
          {state.offsetDays > 0 ? ` (${state.offsetDays} days ahead)` : ' (the real date)'}. Reviews, lessons and progress all use this date.
        </p>
      )}
      <div className="row">
        {[1, 7, 30].map((days) => (
          <button key={days} type="button" className="secondary" onClick={() => void run({ action: 'move', days })}>
            +{days} day{days === 1 ? '' : 's'}
          </button>
        ))}
        <button type="button" className="secondary" onClick={() => void run({ action: 'reset' })}>
          Back to the real date
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  )
}
