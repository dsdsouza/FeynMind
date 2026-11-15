import { useEffect, useState } from 'react'
import type { ConceptProgress, ProgressView, RecallMetric } from '../../../shared/reviews'
import { api, formatDay, messageOf, unwrap } from '../lib'

const STATE_LABEL: Record<ConceptProgress['state'], string> = { learning: 'Not learned yet', scheduled: 'Scheduled', lapsed: 'Missed last review' }
/** Below this many concepts a recall share is not shown as a percentage. */
const ENOUGH = 5

/**
 * What the learner remembers: delayed recall at 7 and 30 days (the PRD's success metric), reviews
 * per day, the reviews coming up, and every concept's memory. Computed on this computer from the
 * stored reviews; it works offline.
 */
export function Progress() {
  const [view, setView] = useState<ProgressView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const session = unwrap(await api['sessions:current']())
        const progress = unwrap(await api['reviews:progress']({ sessionId: session.id }))
        if (!cancelled) setView(progress)
      } catch (e) {
        if (!cancelled) setError(messageOf(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="screen" aria-labelledby="progress-title">
      <h1 id="progress-title">Progress</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {view && (
        <>
          <p className="muted">Measured from your reviews on this computer. Nothing is sent anywhere.</p>
          <div className="recall-metrics">
            {view.recall.map((m) => (
              <RecallCard key={m.name} metric={m} />
            ))}
          </div>
          <BarChart title="Reviews per day, last 30 days" data={view.daily.map((d) => ({ day: d.day, value: d.reviews, part: d.recalled }))} partLabel="recalled" testId="daily-chart" />
          <BarChart title="Reviews coming up, next 14 days" data={view.forecast.map((d) => ({ day: d.day, value: d.due, part: null }))} partLabel="" testId="forecast-chart" />
          <h2>Concepts</h2>
          <table className="progress-table" data-testid="progress-concepts">
            <thead>
              <tr>
                <th scope="col">Concept</th>
                <th scope="col">State</th>
                <th scope="col">Learned</th>
                <th scope="col">Last review</th>
                <th scope="col">Next review</th>
                <th scope="col">Recall now</th>
                <th scope="col">Memory (days)</th>
                <th scope="col">Reviews</th>
              </tr>
            </thead>
            <tbody>
              {view.concepts.map((c) => (
                <tr key={c.conceptId}>
                  <th scope="row">
                    {c.name} <span className="muted">· {c.unitTitle}</span>
                  </th>
                  <td>{STATE_LABEL[c.state]}</td>
                  <td>{c.learnedDay ? formatDay(c.learnedDay) : '—'}</td>
                  <td>{c.lastDay && c.reviews > 0 ? formatDay(c.lastDay) : '—'}</td>
                  <td>{c.dueDay ? formatDay(c.dueDay) : '—'}</td>
                  <td>{c.recallNow !== null ? `${Math.round(c.recallNow * 100)}%` : '—'}</td>
                  <td>{c.stability !== null ? c.stability.toFixed(1) : '—'}</td>
                  <td>
                    {c.reviews}
                    {c.lapses > 0 ? ` (${c.lapses} missed)` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

function RecallCard({ metric }: { metric: RecallMetric }) {
  const share = metric.measured > 0 ? metric.recalled / metric.measured : null
  return (
    <div className="card recall" data-testid={`recall-${metric.name.replace(' ', '-')}`}>
      <h2>Recall at {metric.name}</h2>
      {metric.measured >= ENOUGH && share !== null ? <p className="big">{Math.round(share * 100)}%</p> : <p className="big muted">—</p>}
      <p className="muted">
        {metric.recalled} of {metric.measured} concept{metric.measured === 1 ? '' : 's'} recalled at their first review {metric.from} to {metric.to} days after learning
        {metric.measured < ENOUGH ? ` (shown as a percentage from ${ENOUGH} concepts)` : ''}.
      </p>
    </div>
  )
}

/** Simple bars, one per day; `part` is the share drawn darker (recalled reviews). Keyboard and screen readers get a list. */
function BarChart({ title, data, partLabel, testId }: { title: string; data: { day: string; value: number; part: number | null }[]; partLabel: string; testId: string }) {
  const max = Math.max(1, ...data.map((d) => d.value))
  return (
    <figure className="bars" data-testid={testId}>
      <figcaption>
        <h2>{title}</h2>
      </figcaption>
      <ol className="bar-list">
        {data.map((d) => (
          <li key={d.day} title={`${formatDay(d.day)}: ${d.value}${d.part !== null ? `, ${d.part} ${partLabel}` : ''}`}>
            <span className="bar" style={{ height: `${(d.value / max) * 100}%` }} aria-hidden="true">
              {d.part !== null && d.value > 0 && <span className="bar-part" style={{ height: `${(d.part / d.value) * 100}%` }} />}
            </span>
            <span className="visually-hidden">
              {formatDay(d.day)}: {d.value}
              {d.part !== null ? `, ${d.part} ${partLabel}` : ''}
            </span>
          </li>
        ))}
      </ol>
    </figure>
  )
}
