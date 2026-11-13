import { useCallback, useEffect, useState } from 'react'
import type { Session } from '../../../shared/ingestion'
import type { ConsentState, DraftExam, DraftUnit, JobSummary, SyllabusDraft, SyllabusState, TocEntry, UnitSummary, UsageSummary } from '../../../shared/knowledge'
import { api, formatCost, formatPages, formatTokens, messageOf, unwrap } from '../lib'
import { Review } from './Review'

/** The course: its syllabus, its units, and turning a unit into concepts. */
export function Course() {
  const [session, setSession] = useState<Session | null>(null)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [consent, setConsent] = useState<ConsentState | null>(null)
  const [syllabus, setSyllabus] = useState<SyllabusState | null>(null)
  const [units, setUnits] = useState<UnitSummary[]>([])
  const [jobs, setJobs] = useState<Map<number, JobSummary>>(new Map())
  const [editing, setEditing] = useState(false)
  const [reviewUnit, setReviewUnit] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (sessionId: number) => {
    const [s, u, j, us, c] = await Promise.all([
      api['syllabus:get']({ sessionId }),
      api['units:list']({ sessionId }),
      api['knowledge:jobs']({ sessionId }),
      api['usage:get']({ sessionId }),
      api['consent:get']({ sessionId })
    ])
    setSyllabus(unwrap(s))
    setUnits(unwrap(u))
    setJobs(new Map(unwrap(j).map((job) => [job.id, job])))
    setUsage(unwrap(us))
    setConsent(unwrap(c))
  }, [])

  useEffect(() => {
    let cancelled = false
    let sessionId: number | null = null
    void (async () => {
      try {
        const current = unwrap(await api['sessions:current']())
        if (cancelled) return
        sessionId = current.id
        setSession(current)
        await refresh(current.id)
      } catch (e) {
        if (!cancelled) setError(messageOf(e))
      }
    })()
    const offJob = api.on('knowledge:job', (job) => {
      setJobs((map) => new Map(map).set(job.id, job))
      if (sessionId !== null && (job.status === 'done' || job.status === 'failed')) void refresh(sessionId).catch((e: unknown) => setError(messageOf(e)))
    })
    const offUsage = api.on('usage:changed', setUsage)
    return () => {
      cancelled = true
      offJob()
      offUsage()
    }
  }, [refresh])

  async function act(action: () => Promise<void>) {
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(messageOf(e))
    }
  }

  if (reviewUnit !== null) return <Review unitId={reviewUnit} onBack={() => setReviewUnit(null)} />

  const syllabusJob = syllabus?.job ? (jobs.get(syllabus.job.id) ?? syllabus.job) : null
  const showEditor = syllabus !== null && (syllabus.status === 'draft' || (editing && syllabus.status === 'confirmed')) && syllabus.draft !== null

  return (
    <section className="screen" aria-labelledby="course-title">
      <h1 id="course-title">Course</h1>
      {session && <p className="muted">{session.name}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {usage && <UsageLine usage={usage} />}

      {session && (!syllabus || syllabus.status === 'awaiting-approval' || syllabus.status === 'reading' || syllabusJob?.status === 'failed') && (
        <SyllabusImport
          sessionId={session.id}
          syllabus={syllabus}
          job={syllabusJob}
          consent={consent}
          usage={usage}
          onChange={() => act(() => refresh(session.id))}
          onConsent={setConsent}
          onError={setError}
        />
      )}

      {session && showEditor && syllabus?.draft && (
        <SyllabusEditor
          syllabus={syllabus}
          draft={syllabus.draft}
          onSaved={(saved) => {
            setUnits(saved)
            setEditing(false)
            void act(() => refresh(session.id))
          }}
          onCancel={syllabus.status === 'confirmed' ? () => setEditing(false) : null}
          onError={setError}
        />
      )}

      {session && syllabus?.status === 'confirmed' && !editing && (
        <>
          <Units
            units={units}
            jobs={jobs}
            consent={consent}
            usage={usage}
            onConsent={setConsent}
            onJob={(job) => setJobs((map) => new Map(map).set(job.id, job))}
            onReview={setReviewUnit}
            onError={setError}
          />
          <p>
            <button type="button" className="secondary" onClick={() => setEditing(true)}>
              Edit syllabus
            </button>{' '}
            <button type="button" className="secondary" onClick={() => void act(async () => setSyllabus(null))}>
              Import a new syllabus
            </button>
          </p>
        </>
      )}
    </section>
  )
}

function UsageLine({ usage }: { usage: UsageSummary }) {
  const cap = usage.callCap === null ? 'no cap' : `cap ${usage.callCap}`
  return (
    <p className="muted" aria-live="polite" data-testid="usage">
      Model use in this course: {usage.calls} calls ({cap}), {formatTokens(usage.inputTokens)} tokens in, {formatTokens(usage.outputTokens)} out
      {usage.price ? `, ${formatCost(usage.costUsd)} at paid-tier prices` : ''}.
    </p>
  )
}

/** The one-time notice before course material is first sent to the provider. */
function ConsentNotice({ consent, onConfirm, onCancel }: { consent: ConsentState; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="card warning-card" role="alertdialog" aria-labelledby="consent-title" aria-describedby="consent-text">
      <h2 id="consent-title">Before sending course material</h2>
      <div id="consent-text">
        <p>
          This job sends parts of your course material to <strong>{consent.provider}</strong>: the text of book pages and syllabus, and images of pages that
          contain math or figures.
        </p>
        <p>Free tiers of model providers may use what you send to improve their products. Paid tiers usually do not. Check your provider’s terms.</p>
        <p className="muted">You will see this once for this course.</p>
      </div>
      <div className="row">
        <button type="button" onClick={onConfirm}>
          I understand, continue
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** Approve, with the consent notice first when it has not been confirmed. */
function useApprove(sessionId: number | null, consent: ConsentState | null, onConsent: (c: ConsentState) => void, onJob: (job: JobSummary) => void, onError: (m: string) => void) {
  const [asking, setAsking] = useState<number | null>(null)
  async function approve(jobId: number) {
    if (consent && !consent.given) {
      setAsking(jobId)
      return
    }
    try {
      onJob(unwrap(await api['knowledge:approve']({ jobId })))
    } catch (e) {
      onError(messageOf(e))
    }
  }
  async function confirm() {
    if (asking === null || sessionId === null) return
    const jobId = asking
    setAsking(null)
    try {
      onConsent(unwrap(await api['consent:give']({ sessionId })))
      onJob(unwrap(await api['knowledge:approve']({ jobId })))
    } catch (e) {
      onError(messageOf(e))
    }
  }
  const notice = asking !== null && consent ? <ConsentNotice consent={consent} onConfirm={() => void confirm()} onCancel={() => setAsking(null)} /> : null
  return { approve, notice }
}

function EstimateCard({ job, usage, onApprove, onCancel }: { job: JobSummary; usage: UsageSummary | null; onApprove: () => void; onCancel: () => void }) {
  const e = job.estimate
  const left = usage && usage.callCap !== null ? Math.max(0, usage.callCap - usage.calls) : null
  return (
    <div className="card" aria-labelledby={`estimate-${job.id}`} data-testid="estimate">
      <h3 id={`estimate-${job.id}`}>Estimate{job.unitTitle ? ` for ${job.unitTitle}` : ''}</h3>
      <table className="estimate">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">New calls</th>
            <th scope="col">Already paid for</th>
            <th scope="col">Tokens in</th>
            <th scope="col">Tokens out</th>
          </tr>
        </thead>
        <tbody>
          {e.parts.map((p) => (
            <tr key={p.kind}>
              <td>{p.label}</td>
              <td>
                {p.approximate ? 'about ' : ''}
                {p.calls}
              </td>
              <td>{p.cached}</td>
              <td>{formatTokens(p.inputTokens)}</td>
              <td>{formatTokens(p.outputTokens)}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Total</th>
            <td data-testid="estimate-calls">{e.calls}</td>
            <td />
            <td>{formatTokens(e.inputTokens)}</td>
            <td>{formatTokens(e.outputTokens)}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted">
        Model {e.model}. {e.costUsd === null ? 'No price is known for this model.' : `About ${formatCost(e.costUsd)} at paid-tier prices (free on the free tier).`} Up to{' '}
        {e.maxRetryCalls} more calls if replies have to be retried.{' '}
        {e.calibrationSamples === 0 ? 'Token estimates use default ratios until there are real calls to learn from.' : `Calibrated from ${e.calibrationSamples} earlier calls.`}
        {left !== null && ` The session's cap leaves ${left} calls.`}
      </p>
      <div className="row">
        <button type="button" onClick={onApprove}>
          Approve and run
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function JobProgress({ job, onJob, onError }: { job: JobSummary; onJob: (job: JobSummary) => void; onError: (m: string) => void }) {
  async function call(channel: 'knowledge:pause' | 'knowledge:resume' | 'knowledge:cancel') {
    try {
      onJob(unwrap(await api[channel]({ jobId: job.id })))
    } catch (e) {
      onError(messageOf(e))
    }
  }
  const status: Record<JobSummary['status'], string> = {
    'awaiting-approval': 'Waiting for approval',
    running: 'Running',
    paused: 'Paused',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled'
  }
  const off = job.estimate.calls > 0 ? Math.round(((job.actual.calls - job.estimate.calls) / job.estimate.calls) * 100) : null
  return (
    <div className="job" aria-live="polite" data-testid={`job-${job.id}`}>
      <p>
        <strong>{status[job.status]}</strong>: {job.steps.done + job.steps.failed} of {job.steps.total} steps.{' '}
        {job.actual.calls} of about {job.estimate.calls} calls
        {job.actual.cacheHits > 0 ? ` (${job.actual.cacheHits} answered from the cache)` : ''}, {formatTokens(job.actual.inputTokens)} /{' '}
        {formatTokens(job.estimate.inputTokens)} tokens in, {formatTokens(job.actual.outputTokens)} / {formatTokens(job.estimate.outputTokens)} out
        {job.actual.costUsd !== null && job.estimate.costUsd !== null ? `, ${formatCost(job.actual.costUsd)} of ${formatCost(job.estimate.costUsd)}` : ''}.
        {job.status === 'done' && off !== null && ` Calls were ${off >= 0 ? `${off}% over` : `${-off}% under`} the estimate.`}
      </p>
      {job.pauseReason && (
        <p className="warning">
          {job.pauseReason}
          {job.resumeAt && ` It will try again at ${new Date(job.resumeAt).toLocaleString()}.`}
        </p>
      )}
      {job.error && <p className="error">{job.error}</p>}
      {job.failures.length > 0 && (
        <details>
          <summary>
            {job.failures.length} step{job.failures.length === 1 ? '' : 's'} failed
          </summary>
          <ul>
            {job.failures.map((f, i) => (
              <li key={i}>
                {f.label}: {f.error}
              </li>
            ))}
          </ul>
          <p className="muted">Estimate the unit again to retry them; finished steps are not paid for again.</p>
        </details>
      )}
      <div className="row">
        {job.status === 'running' && (
          <button type="button" className="secondary small" onClick={() => void call('knowledge:pause')}>
            Pause
          </button>
        )}
        {job.status === 'paused' && (
          <button type="button" className="small" onClick={() => void call('knowledge:resume')}>
            Resume
          </button>
        )}
        {(job.status === 'running' || job.status === 'paused') && (
          <button type="button" className="secondary small" onClick={() => void call('knowledge:cancel')}>
            Cancel job
          </button>
        )}
      </div>
    </div>
  )
}

function SyllabusImport(props: {
  sessionId: number
  syllabus: SyllabusState | null
  job: JobSummary | null
  consent: ConsentState | null
  usage: UsageSummary | null
  onChange: () => Promise<void>
  onConsent: (c: ConsentState) => void
  onError: (m: string) => void
}) {
  const { sessionId, syllabus, job, consent, usage, onChange, onConsent, onError } = props
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const { approve, notice } = useApprove(sessionId, consent, onConsent, () => void onChange(), onError)

  async function start(kind: 'file' | 'text') {
    setBusy(true)
    try {
      const result = kind === 'file' ? unwrap(await api['syllabus:importFile']({ sessionId })) : unwrap(await api['syllabus:importText']({ sessionId, text }))
      if (result) await onChange()
    } catch (e) {
      onError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  const waiting = job?.status === 'awaiting-approval'
  const active = job && (job.status === 'running' || job.status === 'paused')
  return (
    <div className="card" aria-labelledby="syllabus-title">
      <h2 id="syllabus-title">Syllabus</h2>
      {!waiting && !active && (
        <>
          <p>Import the course syllabus. It is read on this computer, then the model reads it into units and matches each unit to your materials’ sections. You check the result before it is saved.</p>
          {job?.status === 'failed' && <p className="error">Reading the syllabus failed: {job.error ?? 'unknown error'}. Try again.</p>}
          <p>
            <button type="button" onClick={() => void start('file')} disabled={busy}>
              Import syllabus PDF…
            </button>
          </p>
          <label htmlFor="syllabus-text">Or paste the syllabus text</label>
          <textarea id="syllabus-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
          <p>
            <button type="button" className="secondary" onClick={() => void start('text')} disabled={busy || text.trim() === ''}>
              Use pasted text
            </button>
          </p>
        </>
      )}
      {syllabus && <p className="muted">Source: {syllabus.sourceName}</p>}
      {waiting && job && (
        <EstimateCard
          job={job}
          usage={usage}
          onApprove={() => void approve(job.id)}
          onCancel={() => void api['knowledge:cancel']({ jobId: job.id }).then(() => onChange())}
        />
      )}
      {notice}
      {active && job && <JobProgress job={job} onJob={() => void onChange()} onError={onError} />}
    </div>
  )
}

function tocLabel(t: TocEntry): string {
  return `${[t.chapter, t.section].filter(Boolean).join(' › ') || 'Untitled'} (${t.fileName}, ${formatPages(t.pageStart, t.pageEnd)})`
}

function SyllabusEditor(props: { syllabus: SyllabusState; draft: SyllabusDraft; onSaved: (units: UnitSummary[]) => void; onCancel: (() => void) | null; onError: (m: string) => void }) {
  const { syllabus, onSaved, onCancel, onError } = props
  const [units, setUnits] = useState<DraftUnit[]>(props.draft.units)
  const [exams, setExams] = useState<DraftExam[]>(props.draft.exams)
  const [saving, setSaving] = useState(false)

  const update = (i: number, change: Partial<DraftUnit>) => setUnits((list) => list.map((u, j) => (j === i ? { ...u, ...change } : u)))
  const move = (i: number, by: number) =>
    setUnits((list) => {
      const next = [...list]
      const [item] = next.splice(i, 1)
      if (item) next.splice(i + by, 0, item)
      // Exams refer to units by position; keep them pointing at the same units.
      setExams((es) => es.map((e) => ({ ...e, units: e.units.map((u) => (u === i ? i + by : u === i + by ? i : u)) })))
      return next
    })
  const remove = (i: number) => {
    setUnits((list) => list.filter((_, j) => j !== i))
    setExams((es) => es.map((e) => ({ ...e, units: e.units.filter((u) => u !== i).map((u) => (u > i ? u - 1 : u)) })))
  }

  async function save() {
    setSaving(true)
    try {
      onSaved(unwrap(await api['syllabus:save']({ syllabusId: syllabus.id, draft: { units, exams } })))
    } catch (e) {
      onError(messageOf(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card" aria-labelledby="editor-title">
      <h2 id="editor-title">Check the syllabus</h2>
      <p>This is how the model read the syllabus. Correct anything that is wrong, then save. Units are taught in this order.</p>
      {syllabus.toc.length === 0 && <p className="warning">No materials are imported yet, so units cannot be matched to sections. Import the textbook first, then import the syllabus again.</p>}
      <ol className="units-editor">
        {units.map((u, i) => (
          <li key={i} className="card" aria-label={`Unit ${i + 1}`}>
            <div className="row">
              <label className="grow">
                Title
                <input value={u.title} onChange={(e) => update(i, { title: e.target.value })} />
              </label>
              <button type="button" className="secondary small" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move unit ${i + 1} up`}>
                Up
              </button>
              <button type="button" className="secondary small" onClick={() => move(i, 1)} disabled={i === units.length - 1} aria-label={`Move unit ${i + 1} down`}>
                Down
              </button>
              <button type="button" className="secondary small" onClick={() => remove(i)} aria-label={`Remove unit ${i + 1}`}>
                Remove
              </button>
            </div>
            <div className="row">
              <label>
                Starts
                <input type="date" value={u.startDate ?? ''} onChange={(e) => update(i, { startDate: e.target.value || null })} />
              </label>
              <label>
                Ends
                <input type="date" value={u.endDate ?? ''} onChange={(e) => update(i, { endDate: e.target.value || null })} />
              </label>
              <label>
                Exam weight (%)
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={u.examWeight ?? ''}
                  onChange={(e) => update(i, { examWeight: e.target.value === '' ? null : Number(e.target.value) })}
                />
              </label>
            </div>
            {u.topics.length > 0 && <p className="muted">Topics: {u.topics.join('; ')}</p>}
            {u.readings.length > 0 && <p className="muted">Readings: {u.readings.join('; ')}</p>}
            <label>
              Sections it covers
              <select
                multiple
                size={Math.min(8, Math.max(3, syllabus.toc.length))}
                value={u.tocKeys}
                onChange={(e) => update(i, { tocKeys: [...e.target.selectedOptions].map((o) => o.value) })}
              >
                {syllabus.toc.map((t) => (
                  <option key={t.key} value={t.key}>
                    {tocLabel(t)}
                  </option>
                ))}
              </select>
            </label>
            {u.tocKeys.length === 0 && <p className="warning">No sections: this unit cannot be processed until you choose some.</p>}
          </li>
        ))}
      </ol>
      <p>
        <button
          type="button"
          className="secondary"
          onClick={() => setUnits((list) => [...list, { title: 'New unit', topics: [], startDate: null, endDate: null, examWeight: null, readings: [], tocKeys: [] }])}
        >
          Add unit
        </button>
      </p>
      {exams.length > 0 && (
        <>
          <h3>Exams</h3>
          <ul>
            {exams.map((e, i) => (
              <li key={i} className="row">
                <label className="grow">
                  Title
                  <input value={e.title} onChange={(ev) => setExams((es) => es.map((x, j) => (j === i ? { ...x, title: ev.target.value } : x)))} />
                </label>
                <label>
                  Date
                  <input type="date" value={e.date ?? ''} onChange={(ev) => setExams((es) => es.map((x, j) => (j === i ? { ...x, date: ev.target.value || null } : x)))} />
                </label>
                <label>
                  Weight (%)
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={e.weight ?? ''}
                    onChange={(ev) => setExams((es) => es.map((x, j) => (j === i ? { ...x, weight: ev.target.value === '' ? null : Number(ev.target.value) } : x)))}
                  />
                </label>
                <span className="muted">Covers: {e.units.map((u) => units[u]?.title ?? '?').join(', ') || 'not stated'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="row">
        <button type="button" onClick={() => void save()} disabled={saving}>
          Save syllabus
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {syllabus.status === 'confirmed' && <p className="muted">Saving replaces the current units. Concepts stay, but their link to the old units is removed.</p>}
    </div>
  )
}

function Units(props: {
  units: UnitSummary[]
  jobs: Map<number, JobSummary>
  consent: ConsentState | null
  usage: UsageSummary | null
  onConsent: (c: ConsentState) => void
  onJob: (job: JobSummary) => void
  onReview: (unitId: number) => void
  onError: (m: string) => void
}) {
  const { units, jobs, consent, usage, onConsent, onJob, onReview, onError } = props
  const [selected, setSelected] = useState<number | null>(units[0]?.id ?? null)
  const { approve, notice } = useApprove(usage?.sessionId ?? null, consent, onConsent, onJob, onError)
  const unit = units.find((u) => u.id === selected) ?? units[0]
  const lastJob = unit?.lastJob ? (jobs.get(unit.lastJob.id) ?? unit.lastJob) : null

  async function estimate() {
    if (!unit) return
    try {
      onJob(unwrap(await api['knowledge:estimateUnit']({ unitId: unit.id })))
    } catch (e) {
      onError(messageOf(e))
    }
  }
  const pendingEstimate = [...jobs.values()].find((j) => j.unitId === unit?.id && j.status === 'awaiting-approval') ?? null
  const runningJob = [...jobs.values()].find((j) => j.unitId === unit?.id && (j.status === 'running' || j.status === 'paused')) ?? null
  const shownJob = runningJob ?? (lastJob && lastJob.status !== 'awaiting-approval' && lastJob.status !== 'cancelled' ? lastJob : null)

  return (
    <div className="card" aria-labelledby="units-title">
      <h2 id="units-title">Units</h2>
      <p>Nothing is sent to the model until you choose a unit, see its estimate and approve it. Other units wait until you ask.</p>
      <label htmlFor="unit-select">Unit</label>
      <select id="unit-select" value={unit?.id ?? ''} onChange={(e) => setSelected(Number(e.target.value))}>
        {units.map((u) => (
          <option key={u.id} value={u.id}>
            {u.ordinal + 1}. {u.title}
            {u.conceptCount > 0 ? ` (${u.conceptCount} concepts)` : ''}
          </option>
        ))}
      </select>
      {unit && (
        <div>
          <p className="muted">
            {[unit.startDate && `${unit.startDate}${unit.endDate ? ` to ${unit.endDate}` : ''}`, unit.examWeight !== null && `${unit.examWeight}% of the grade`].filter(Boolean).join(', ')}
          </p>
          {unit.sections.length === 0 ? (
            <p className="warning">This unit has no sections. Edit the syllabus to choose them.</p>
          ) : (
            <ul className="muted">
              {unit.sections.map((s) => (
                <li key={s.key}>{tocLabel(s)}</li>
              ))}
            </ul>
          )}
          {shownJob && <JobProgress job={shownJob} onJob={onJob} onError={onError} />}
          {pendingEstimate ? (
            <EstimateCard
              job={pendingEstimate}
              usage={usage}
              onApprove={() => void approve(pendingEstimate.id)}
              onCancel={() => void api['knowledge:cancel']({ jobId: pendingEstimate.id }).then((r) => r.ok && onJob(r.value))}
            />
          ) : (
            !runningJob && (
              <div className="row">
                <button type="button" onClick={() => void estimate()} disabled={unit.sections.length === 0}>
                  {unit.conceptCount > 0 ? 'Estimate a rebuild' : 'Estimate this unit'}
                </button>
                {unit.conceptCount > 0 && (
                  <button type="button" className="secondary" onClick={() => onReview(unit.id)}>
                    Review concepts
                  </button>
                )}
              </div>
            )
          )}
          {unit.conceptCount > 0 && pendingEstimate && <p className="warning">Rebuilding replaces this unit’s concepts, including your edits to them.</p>}
          {notice}
        </div>
      )}
    </div>
  )
}
