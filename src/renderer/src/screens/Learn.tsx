import { useCallback, useEffect, useState } from 'react'
import type { ConsentState, UsageSummary } from '../../../shared/knowledge'
import { masteryHint, type CallEstimate, type DiagnosticState, type LessonView, type PathState, type Standing, type UnitStatus } from '../../../shared/tutor'
import { api, formatCost, formatTokens, messageOf, unwrap } from '../lib'
import { ConsentNotice, UsageLine } from './Course'
import { Diagnostic } from './Diagnostic'
import { Lesson } from './Lesson'

const STANDING_LABEL: Record<Standing, string> = { known: 'Known', shaky: 'Shaky', new: 'New', 'not-assessed': 'Not assessed' }

/** Learning: the diagnostic, the path with standings, and lessons. Opens straight into a lesson left part way. */
export function Learn() {
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [path, setPath] = useState<PathState | null>(null)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [consent, setConsent] = useState<ConsentState | null>(null)
  const [quiz, setQuiz] = useState<DiagnosticState | null>(null)
  const [lesson, setLesson] = useState<LessonView | null>(null)
  const [asking, setAsking] = useState<(() => Promise<void>) | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (id: number) => {
    const [p, u, c] = await Promise.all([api['tutor:path']({ sessionId: id }), api['usage:get']({ sessionId: id }), api['consent:get']({ sessionId: id })])
    setPath(unwrap(p))
    setUsage(unwrap(u))
    setConsent(unwrap(c))
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
    if (sessionId !== null) await refresh(sessionId).catch((e: unknown) => setError(messageOf(e)))
  }

  const openLesson = (conceptId: number) =>
    withConsent('Preparing the lesson…', async () => {
      if (sessionId === null) return
      setLesson(unwrap(await api['lesson:open']({ sessionId, conceptId })))
    })

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
                <EstimateLine estimate={path.next.estimate} what="This lesson" />
                <button type="button" onClick={() => props.onLesson(path.next?.conceptId ?? 0)} disabled={busy}>
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
              </span>
              <meter min={0} max={1} low={0.3} high={0.6} optimum={1} value={c.mastery.shown} aria-label={`Mastery of ${c.name}`} title={c.mastery.mastered ? 'mastered' : `${Math.round(c.mastery.shown * 100)}%`} />
              <button type="button" className="secondary small" disabled={c.locked || busy} onClick={() => onLesson(c.id)}>
                {c.mastery.mastered ? 'Review' : c.lessonStep ? 'Continue' : 'Learn'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
