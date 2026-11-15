import { useCallback, useEffect, useState } from 'react'
import type { ConsentState, ExamInfo, UsageSummary } from '../../../shared/knowledge'
import { MAX_DAILY_LIMIT, reasonText, type ExamFocus, type SittingView, type TodayState } from '../../../shared/reviews'
import { masteryHint, type CallEstimate, type DiagnosticState, type LessonView, type PathState, type Standing, type UnitStatus } from '../../../shared/tutor'
import { api, formatCost, formatDay, formatTokens, messageOf, unwrap } from '../lib'
import { ConsentNotice, UsageLine } from './Course'
import { Diagnostic } from './Diagnostic'
import { Lesson } from './Lesson'
import { Reviews } from './Reviews'

const STANDING_LABEL: Record<Standing, string> = { known: 'Known', shaky: 'Shaky', new: 'New', 'not-assessed': 'Not assessed' }

/** Learning: the diagnostic, the path with standings, and lessons. Opens straight into a lesson left part way. */
export function Learn({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [path, setPath] = useState<PathState | null>(null)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [consent, setConsent] = useState<ConsentState | null>(null)
  const [quiz, setQuiz] = useState<DiagnosticState | null>(null)
  const [lesson, setLesson] = useState<LessonView | null>(null)
  const [today, setToday] = useState<TodayState | null>(null)
  const [exams, setExams] = useState<ExamInfo[]>([])
  const [sitting, setSitting] = useState<SittingView | null>(null)
  const [lastSitting, setLastSitting] = useState<SittingView | null>(null)
  const [asking, setAsking] = useState<(() => Promise<void>) | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (id: number) => {
    const [p, u, c, t, e, s] = await Promise.all([
      api['tutor:path']({ sessionId: id }),
      api['usage:get']({ sessionId: id }),
      api['consent:get']({ sessionId: id }),
      api['reviews:today']({ sessionId: id }),
      api['exams:list']({ sessionId: id }),
      api['reviews:current']({ sessionId: id })
    ])
    setPath(unwrap(p))
    setUsage(unwrap(u))
    setConsent(unwrap(c))
    setToday(unwrap(t))
    setExams(unwrap(e))
    setLastSitting(unwrap(s))
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const session = unwrap(await api['sessions:current']())
        if (cancelled) return
        setSessionId(session.id)
        await refresh(session.id)
        const open = unwrap(await api['lesson:current']({ sessionId: session.id }))
        if (!cancelled && open) setLesson(open)
      } catch (e) {
        if (!cancelled) setError(messageOf(e))
      }
    })()
    const offUsage = api.on('usage:changed', setUsage)
    return () => {
      cancelled = true
      offUsage()
    }
  }, [refresh])

  /** Runs an action that sends course material, showing the notice first if it was never confirmed. */
  async function withConsent(label: string, action: () => Promise<void>) {
    setError(null)
    const run = async () => {
      setBusy(label)
      try {
        await action()
      } catch (e) {
        setError(messageOf(e))
      } finally {
        setBusy(null)
      }
    }
    if (consent && !consent.given) setAsking(() => run)
    else await run()
  }

  async function confirmConsent() {
    if (sessionId === null || !asking) return
    const run = asking
    setAsking(null)
    try {
      setConsent(unwrap(await api['consent:give']({ sessionId })))
      await run()
    } catch (e) {
      setError(messageOf(e))
    }
  }

  async function back() {
    setQuiz(null)
    setLesson(null)
    setSitting(null)
    if (sessionId !== null) await refresh(sessionId).catch((e: unknown) => setError(messageOf(e)))
  }

  const openLesson = (conceptId: number) =>
    withConsent('Preparing the lesson…', async () => {
      if (sessionId === null) return
      setLesson(unwrap(await api['lesson:open']({ sessionId, conceptId })))
    })

  const startReviews = () =>
    withConsent('Preparing today’s reviews…', async () => {
      if (sessionId === null) return
      setSitting(unwrap(await api['reviews:start']({ sessionId })))
    })

  /** Runs a call that returns today's state, showing any error. */
  const updateToday = (call: () => Promise<TodayState>) =>
    void (async () => {
      try {
        setToday(await call())
        if (sessionId !== null) setPath(unwrap(await api['tutor:path']({ sessionId })))
      } catch (e) {
        setError(messageOf(e))
      }
    })()

  if (sitting) return <Reviews key={sitting.id} initial={sitting} onBack={() => void back()} />
  if (sessionId !== null && lesson) {
    return <Lesson key={lesson.lessonId} sessionId={sessionId} initial={lesson} usage={usage} onBack={() => void back()} onOpen={(id) => void openLesson(id)} />
  }
  if (quiz) return <Diagnostic initial={quiz} onDone={() => void back()} />

  return (
    <section className="screen" aria-labelledby="learn-title">
      <h1 id="learn-title">Learn</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {usage && <UsageLine usage={usage} />}
      {asking && consent && <ConsentNotice consent={consent} onConfirm={() => void confirmConsent()} onCancel={() => setAsking(null)} />}
      {busy && (
        <p className="muted" role="status">
          {busy}
        </p>
      )}
      {path?.modelMissing && (
        <div className="card warning-card" role="alert" data-testid="no-model">
          <p>
            <strong>No model is chosen yet.</strong> Lessons, the diagnostic and reviews send requests to your provider, so they need an API key and a model. Your path and what is due are shown below.
          </p>
          <button type="button" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
      )}
      {today && today.clockBehind && (
        <p className="warning" role="status">
          Your computer’s clock is behind the time of your latest review, so reviews are scheduled from that later time until the clock catches up.
        </p>
      )}
      {today?.examFocus && <ExamBanner focus={today.examFocus} />}
      {today && sessionId !== null && (path?.units.some((u) => u.processed) ?? false) && (
        <TodayCard
          today={today}
          lastSitting={lastSitting}
          busy={busy !== null}
          onStart={() => void startReviews()}
          onOpenLast={() => lastSitting && setSitting(lastSitting)}
          onSkip={() => updateToday(async () => unwrap(await api['reviews:skipToday']({ sessionId })))}
          onLimit={(limit) => updateToday(async () => unwrap(await api['reviews:setLimit']({ sessionId, limit })))}
        />
      )}
      {path && sessionId !== null && (
        <PathView
          path={path}
          busy={busy !== null}
          onDiagnostic={() =>
            withConsent('Writing the quiz…', async () => {
              setQuiz(unwrap(await api['diagnostic:start']({ sessionId })))
            })
          }
          onLesson={(id) => void openLesson(id)}
          onClaimKnown={(unitId) =>
            withConsent('Writing the check…', async () => {
              setQuiz(unwrap(await api['standing:claimKnown']({ sessionId, unitId })))
            })
          }
          onMarkNew={(unitId) =>
            void (async () => {
              try {
                setPath(unwrap(await api['standing:markNew']({ sessionId, unitId })))
              } catch (e) {
                setError(messageOf(e))
              }
            })()
          }
        />
      )}
      {sessionId !== null && exams.length > 0 && (
        <ExamsPanel
          exams={exams}
          onSave={async (examId, date, weight) => {
            setExams(unwrap(await api['exams:update']({ sessionId, examId, date, weight })))
            await refresh(sessionId)
          }}
        />
      )}
    </section>
  )
}

export function EstimateLine({ estimate, what }: { estimate: CallEstimate; what: string }) {
  if (estimate.calls === 0) return <p className="muted">{what}: no model calls needed (already written).</p>
  return (
    <p className="muted" data-testid="tutor-estimate">
      {what}: about {estimate.calls} model call{estimate.calls === 1 ? '' : 's'}, {formatTokens(estimate.inputTokens)} tokens in, {formatTokens(estimate.outputTokens)} out
      {estimate.costUsd !== null ? ` (${formatCost(estimate.costUsd)} at paid-tier prices)` : ''}.
    </p>
  )
}

function PathView(props: {
  path: PathState
  busy: boolean
  onDiagnostic: () => void
  onLesson: (conceptId: number) => void
  onClaimKnown: (unitId: number) => void
  onMarkNew: (unitId: number) => void
}) {
  const { path, busy } = props
  const processed = path.units.some((u) => u.processed)
  if (path.units.length === 0) return <p>Import and confirm a syllabus on the Course screen first.</p>
  return (
    <>
      {!processed && <p>Process a unit on the Course screen first. The diagnostic and lessons use its concepts.</p>}
      {processed && path.diagnostic.status !== 'done' && (
        <div className="card">
          <h2>Find out where you stand</h2>
          <p>A short multiple-choice quiz over the processed units. It starts with the basics and stops following a topic once you miss it. Choose “I don’t know” rather than guessing.</p>
          {path.diagnostic.estimate && <EstimateLine estimate={path.diagnostic.estimate} what="Writing the quiz" />}
          <button type="button" onClick={props.onDiagnostic} disabled={busy}>
            {path.diagnostic.status === 'in-progress' ? 'Continue the diagnostic' : 'Take the diagnostic'}
          </button>
        </div>
      )}
      {(path.openLesson || path.next) && (
        <div className="card">
          {path.openLesson ? (
            <>
              <h2>Pick up where you left off</h2>
              <button type="button" onClick={() => props.onLesson(path.openLesson?.conceptId ?? 0)} disabled={busy}>
                Continue: {path.openLesson.name}
              </button>
            </>
          ) : (
            path.next && (
              <>
                <h2>Next</h2>
                <p className="muted">{path.next.unitTitle}</p>
                <p className="reasons" data-testid="next-reasons">
                  Why: {path.next.reasons.map(reasonText).join(' · ')}
                </p>
                <EstimateLine estimate={path.next.estimate} what="This lesson" />
                {path.reviewsFirst && <p className="muted">Today’s reviews come first. Start them above, or skip them for today.</p>}
                <button type="button" onClick={() => props.onLesson(path.next?.conceptId ?? 0)} disabled={busy || path.reviewsFirst}>
                  Start: {path.next.name}
                </button>
              </>
            )
          )}
        </div>
      )}
      <h2>Your path</h2>
      <ol className="path" aria-label="Units">
        {path.units.map((u) => (
          <UnitItem key={u.id} unit={u} busy={busy} onLesson={props.onLesson} onClaimKnown={props.onClaimKnown} onMarkNew={props.onMarkNew} />
        ))}
      </ol>
    </>
  )
}

function UnitItem({ unit, busy, onLesson, onClaimKnown, onMarkNew }: { unit: UnitStatus; busy: boolean; onLesson: (id: number) => void; onClaimKnown: (id: number) => void; onMarkNew: (id: number) => void }) {
  const [open, setOpen] = useState(false)
  const override = unit.override
  return (
    <li className="card unit" aria-label={`Unit ${unit.ordinal + 1}`}>
      <div className="row">
        <strong className="grow">
          {unit.ordinal + 1}. {unit.title}
        </strong>
        <span className={`standing standing-${unit.standing}`} data-testid="standing">
          {STANDING_LABEL[unit.standing]}
        </span>
      </div>
      {unit.processed ? (
        <p className="muted">
          {unit.mastered} of {unit.concepts.length} concepts mastered
          {override?.claimed === 'known' && override.outcome === 'confirmed' && ' · you showed you know this unit'}
          {override?.claimed === 'known' && override.outcome === 'not-confirmed' && ' · the check did not confirm “I know this”'}
          {override?.claimed === 'new' && ' · you marked this unit as new'}
        </p>
      ) : (
        <p className="muted">Not processed yet, so not assessed.</p>
      )}
      {unit.processed && (
        <div className="row">
          <button type="button" className="secondary small" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide concepts' : 'Show concepts'}
          </button>
          {unit.standing !== 'known' && (
            <button type="button" className="secondary small" onClick={() => onClaimKnown(unit.id)} disabled={busy}>
              I know this
            </button>
          )}
          {unit.standing !== 'new' && (
            <button type="button" className="secondary small" onClick={() => onMarkNew(unit.id)} disabled={busy}>
              Treat as new
            </button>
          )}
        </div>
      )}
      {open && (
        <ul className="path-concepts">
          {unit.concepts.map((c) => (
            <li key={c.id} className="row" aria-label={c.name}>
              <span className="grow">
                {c.locked ? '🔒 ' : c.mastery.mastered ? '✓ ' : ''}
                {c.name}
                {c.locked && <span className="muted"> · after {c.waitingFor.join(', ')}</span>}
                {!c.locked && masteryHint(c.mastery) && <span className="muted"> · {masteryHint(c.mastery)}</span>}
                {c.review?.lapsed && <span className="badge lapsed"> missed last review</span>}
                {c.review && (
                  <span className="muted" data-testid="concept-due">
                    {' '}
                    · next review {formatDay(c.review.dueDay)} · recall now {Math.round(c.review.recall * 100)}%
                  </span>
                )}
              </span>
              <meter min={0} max={1} low={0.3} high={0.6} optimum={1} value={c.mastery.shown} aria-label={`Mastery of ${c.name}`} title={c.mastery.mastered ? 'mastered' : `${Math.round(c.mastery.shown * 100)}%`} />
              {!c.review && (
                <button type="button" className="secondary small" disabled={c.locked || busy} onClick={() => onLesson(c.id)}>
                  {c.lessonStep ? 'Continue' : 'Learn'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** What is due today: the planned reviews with why, the estimate, the daily limit, and the backlog. */
function TodayCard(props: {
  today: TodayState
  lastSitting: SittingView | null
  busy: boolean
  onStart: () => void
  onOpenLast: () => void
  onSkip: () => void
  onLimit: (limit: number) => void
}) {
  const { today } = props
  const [limit, setLimit] = useState(String(today.limit))
  const missed = props.lastSitting?.items.filter((i) => i.lapsed && !i.reteachAttempt).length ?? 0
  const e = today.estimate
  return (
    <div className="card today" data-testid="today">
      <h2>Today’s reviews</h2>
      {today.sitting ? (
        <p>{today.sitting.remaining} review{today.sitting.remaining === 1 ? '' : 's'} left in today’s sitting.</p>
      ) : today.planned.length === 0 ? (
        <p data-testid="nothing-due">{today.answeredToday > 0 ? `Done: ${today.answeredToday} reviewed today.` : 'Nothing is due today.'}</p>
      ) : (
        <>
          <p>
            {today.planned.length} to review{today.held > 0 ? ` (${today.held} more held for later by the daily limit)` : ''}, mixed across topics:
          </p>
          <ul className="planned" aria-label="Planned reviews">
            {today.planned.map((p) => (
              <li key={p.conceptId} data-testid="planned-review">
                <strong>{p.name}</strong> <span className="muted">· {p.unitTitle}</span>
                <span className="reasons"> · {p.reasons.map(reasonText).join(' · ')}</span>
              </li>
            ))}
          </ul>
          {today.catchUpDay && <p className="muted">At {today.limit} a day you are caught up by {formatDay(today.catchUpDay)}.</p>}
          <p className="muted" data-testid="review-estimate">
            About {e.calls} model call{e.calls === 1 ? '' : 's'}: {e.grades} grade{e.grades === 1 ? '' : 's'}
            {e.newQuestionSets > 0 ? `, ${e.newQuestionSets} set${e.newQuestionSets === 1 ? '' : 's'} of new questions` : ''}; {formatTokens(e.inputTokens)} tokens in, {formatTokens(e.outputTokens)} out
            {e.costUsd !== null ? ` (${formatCost(e.costUsd)})` : ''}. A missed review adds {e.perReteach} if you take the re-teach.
          </p>
        </>
      )}
      {today.waitingGrades > 0 && (
        <p className="muted" role="status">
          {today.waitingGrades} answer{today.waitingGrades === 1 ? ' is' : 's are'} saved and will be graded when you are back online.
        </p>
      )}
      <div className="row">
        {(today.sitting || today.planned.length > 0) && (
          <button type="button" onClick={props.onStart} disabled={props.busy}>
            {today.sitting ? 'Continue reviews' : `Start reviews (${today.planned.length})`}
          </button>
        )}
        {missed > 0 && !today.sitting && (
          <button type="button" className="secondary" onClick={props.onOpenLast}>
            Re-teach what you missed ({missed})
          </button>
        )}
        {today.lessonsWait && (
          <button type="button" className="secondary" onClick={props.onSkip} disabled={props.busy}>
            Skip reviews today
          </button>
        )}
      </div>
      <details>
        <summary>Daily limit: {today.limit}</summary>
        <div className="row">
          <label htmlFor="daily-limit">Reviews per day</label>
          <input id="daily-limit" type="number" min={1} max={MAX_DAILY_LIMIT} value={limit} onChange={(ev) => setLimit(ev.target.value)} />
          <button type="button" className="secondary small" onClick={() => props.onLimit(Number(limit))}>
            Save
          </button>
        </div>
        <p className="muted">Reviews beyond the limit wait for the next day; the most at-risk come first.</p>
      </details>
    </div>
  )
}

function ExamBanner({ focus }: { focus: ExamFocus }) {
  const when = focus.inDays === 0 ? 'today' : focus.inDays === 1 ? 'tomorrow' : `in ${focus.inDays} days`
  return (
    <div className="card exam-banner" role="status" data-testid="exam-banner">
      <strong>
        {focus.title} is {when} ({formatDay(focus.date)}).
      </strong>{' '}
      Recommendations now put {focus.unitTitles.join(', ')} first: the heaviest-weighted and weakest concepts{focus.weightsGiven ? '' : ' (the syllabus gives no weights, so its units count equally)'}.
    </div>
  )
}

/** Exam dates and weights, edited in place (the syllabus's units and their concepts are untouched). */
function ExamsPanel({ exams, onSave }: { exams: ExamInfo[]; onSave: (examId: number, date: string | null, weight: number | null) => Promise<void> }) {
  return (
    <details className="card">
      <summary>
        <h2 className="inline">Exams</h2>
      </summary>
      <p className="muted">When an exam is within 14 days, recommendations favour its units. Change a date or weight here; nothing else in the course changes.</p>
      <ul className="exams">
        {exams.map((e) => (
          <ExamRow key={e.id} exam={e} onSave={onSave} />
        ))}
      </ul>
    </details>
  )
}

function ExamRow({ exam, onSave }: { exam: ExamInfo; onSave: (examId: number, date: string | null, weight: number | null) => Promise<void> }) {
  const [date, setDate] = useState(exam.date ?? '')
  const [weight, setWeight] = useState(exam.weight === null ? '' : String(exam.weight))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  async function save() {
    setError(null)
    setSaved(false)
    try {
      await onSave(exam.id, date === '' ? null : date, weight === '' ? null : Number(weight))
      setSaved(true)
    } catch (e) {
      setError(messageOf(e))
    }
  }
  return (
    <li className="row" aria-label={exam.title}>
      <strong className="grow">{exam.title}</strong>
      <span className="muted">{exam.units.length > 0 ? exam.units.map((u) => u.title).join(', ') : 'whole course'}</span>
      <label>
        Date <input type="date" value={date} onChange={(ev) => setDate(ev.target.value)} aria-label={`Date of ${exam.title}`} />
      </label>
      <label>
        Weight (%) <input type="number" min={0} max={100} value={weight} onChange={(ev) => setWeight(ev.target.value)} aria-label={`Weight of ${exam.title}`} />
      </label>
      <button type="button" className="secondary small" onClick={() => void save()}>
        Save
      </button>
      {saved && <span className="muted">Saved</span>}
      {error && <span className="error">{error}</span>}
    </li>
  )
}
