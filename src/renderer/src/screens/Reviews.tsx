import { useEffect, useState } from 'react'
import { reasonText, type ReviewItemView, type SittingView } from '../../../shared/reviews'
import type { AttemptView } from '../../../shared/tutor'
import { AnswerInputs } from '../components/AnswerInputs'
import { PagePreview } from '../components/PagePreview'
import { TutorText, type CitedPage } from '../components/TutorText'
import { api, formatDay, messageOf, unwrap } from '../lib'
import { GradeCard } from './Lesson'

/**
 * A review sitting: one question at a time, recall only (no explanation, no scaffold, the concept
 * not named until answered). After each answer the grade is shown; a missed review offers a short
 * re-teach and a question that checks it. Answers given offline are saved and graded later.
 */
export function Reviews({ initial, onBack }: { initial: SittingView; onBack: () => void }) {
  const [sitting, setSitting] = useState(initial)
  /** The answered item whose feedback is on screen, until "Next". */
  const [showing, setShowing] = useState<number | null>(null)
  const [reteaching, setReteaching] = useState<number | null>(null)
  const [streamed, setStreamed] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<CitedPage | null>(null)

  useEffect(() => {
    const offSitting = api.on('reviews:sitting', (v) => {
      if (v.id === initial.id) setSitting(v)
    })
    const offStream = api.on('reviews:stream', (e) => setStreamed((s) => (e.kind === 'reset' ? '' : s + e.text)))
    return () => {
      offSitting()
      offStream()
    }
  }, [initial.id])

  const current = sitting.items.find((i) => i.status === 'pending') ?? null
  const shown = showing !== null ? sitting.items.find((i) => i.id === showing) : undefined
  const reteachItem = reteaching !== null ? sitting.items.find((i) => i.id === reteaching) : undefined
  const done = sitting.items.filter((i) => i.status === 'answered').length

  useEffect(() => {
    if (current && !shown && !reteachItem) void api['reviews:shown']({ itemId: current.id })
  }, [current, shown, reteachItem])

  async function act(action: () => Promise<SittingView>) {
    setSending(true)
    setError(null)
    try {
      setSitting(await action())
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setSending(false)
    }
  }

  const open = (page: CitedPage) => setPreview(page)

  return (
    <section className="screen reviews" aria-labelledby="reviews-title">
      <div className="row">
        <button type="button" className="link" onClick={onBack}>
          ← Learn
        </button>
      </div>
      <h1 id="reviews-title">Today’s reviews</h1>
      <p className="muted" aria-live="polite">
        {done} of {sitting.items.length} answered
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {sitting.blocked && (
        <p className="warning" role="status">
          {sitting.blocked.message}
        </p>
      )}
      <div className={preview ? 'lesson-body with-preview' : 'lesson-body'}>
        <div className="lesson-main">
          {reteachItem ? (
            <Reteach item={reteachItem} streamed={streamed} sending={sending} act={act} onOpenPage={open} onDone={() => setReteaching(null)} />
          ) : shown ? (
            <Feedback
              item={shown}
              sending={sending}
              act={act}
              onOpenPage={open}
              onReteach={() => {
                setStreamed('')
                setReteaching(shown.id)
                void act(async () => unwrap(await api['reviews:reteach']({ itemId: shown.id })))
              }}
              onNext={() => setShowing(null)}
            />
          ) : current ? (
            <Question key={current.id} item={current} index={sitting.items.indexOf(current) + 1} sending={sending} act={act} onAnswered={() => setShowing(current.id)} onOpenPage={open} />
          ) : (
            <Summary sitting={sitting} onReteach={(id) => {
              setStreamed('')
              setReteaching(id)
              void act(async () => unwrap(await api['reviews:reteach']({ itemId: id })))
            }} onBack={onBack} />
          )}
        </div>
        {preview && (
          <aside className="lesson-preview" aria-label="Cited page">
            <PagePreview materialId={preview.materialId} page={preview.page} label={preview.label} fileName={preview.fileName} onClose={() => setPreview(null)} />
          </aside>
        )}
      </div>
    </section>
  )
}

function Question(props: { item: ReviewItemView; index: number; sending: boolean; act: (a: () => Promise<SittingView>) => Promise<void>; onAnswered: () => void; onOpenPage: (p: CitedPage) => void }) {
  const { item, act } = props
  if (!item.question) {
    return (
      <div className="card warning-card" role="alert">
        <p>This review has no question yet{item.error ? `: ${item.error}` : '.'}</p>
      </div>
    )
  }
  return (
    <div className="card question" aria-labelledby="review-question-title" data-testid="review-question">
      <h2 id="review-question-title">Review {props.index}</h2>
      <p className="muted">{item.reasons.map(reasonText).join(' · ')}</p>
      <TutorText text={item.question.stem} sources={item.sources} onOpenPage={props.onOpenPage} />
      {item.hint && (
        <p className="hint" data-testid="review-hint">
          <strong>Hint:</strong> {item.hint}
        </p>
      )}
      <AnswerInputs
        idPrefix="review-"
        initialAnswer={item.draft}
        initialReasoning={item.draftReasoning}
        sending={props.sending}
        onDraft={(field, text) => void api['reviews:draft']({ itemId: item.id, field, text })}
        onSubmit={(answer, reasoning, skipped) => {
          props.onAnswered()
          void act(async () => unwrap(await api['reviews:answer']({ itemId: item.id, answer, reasoning, skipped })))
        }}
        extra={
          !item.hint && (
            <button type="button" className="secondary" disabled={props.sending} onClick={() => void act(async () => unwrap(await api['reviews:hint']({ itemId: item.id })))}>
              Show a hint (counts as help)
            </button>
          )
        }
      />
    </div>
  )
}

function AttemptResult({ attempt, item, sending, act, onOpenPage }: { attempt: AttemptView; item: ReviewItemView; sending: boolean; act: (a: () => Promise<SittingView>) => Promise<void>; onOpenPage: (p: CitedPage) => void }) {
  const [contesting, setContesting] = useState(false)
  const [objection, setObjection] = useState('')
  return (
    <div className="attempt">
      <p className="muted">Your answer{attempt.skipped ? ': I don’t know' : ':'}</p>
      {!attempt.skipped && (
        <blockquote>
          <TutorText text={attempt.answer} sources={[]} onOpenPage={onOpenPage} />
        </blockquote>
      )}
      {attempt.status === 'saved' && (
        <p className="muted" role="status" data-testid="review-saved">
          {item.error ?? 'Saved. Grading…'}
        </p>
      )}
      {attempt.grades.map((g) => (
        <GradeCard key={g.pass} grade={g} sources={item.sources} onOpenPage={onOpenPage} />
      ))}
      {attempt.contestPending && (
        <p className="muted" role="status">
          Your objection is saved. Grading again…
        </p>
      )}
      {attempt.canContest &&
        (contesting ? (
          <div className="contest">
            <label htmlFor={`objection-${attempt.id}`}>Why is the grade wrong? A second grading will see this. You can contest once.</label>
            <textarea id={`objection-${attempt.id}`} rows={3} value={objection} onChange={(e) => setObjection(e.target.value)} />
            <div className="row">
              <button
                type="button"
                disabled={sending || objection.trim() === ''}
                onClick={() =>
                  void act(async () => {
                    const view = unwrap(await api['reviews:contest']({ attemptId: attempt.id, objection }))
                    if (!view) throw new Error('That answer belongs to a lesson.')
                    return view
                  })
                }
              >
                Send for a second grading
              </button>
              <button type="button" className="secondary" onClick={() => setContesting(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="link" onClick={() => setContesting(true)}>
            Contest this grade
          </button>
        ))}
    </div>
  )
}

function Feedback(props: { item: ReviewItemView; sending: boolean; act: (a: () => Promise<SittingView>) => Promise<void>; onOpenPage: (p: CitedPage) => void; onReteach: () => void; onNext: () => void }) {
  const { item } = props
  return (
    <div className="card question" data-testid="review-feedback">
      <h2>{item.conceptName || 'Your answer'}</h2>
      {item.unitTitle && <p className="muted">{item.unitTitle}</p>}
      {item.question && <TutorText text={item.question.stem} sources={item.sources} onOpenPage={props.onOpenPage} />}
      {item.attempt ? <AttemptResult attempt={item.attempt} item={item} sending={props.sending} act={props.act} onOpenPage={props.onOpenPage} /> : <p className="muted">Saving…</p>}
      {item.nextDue && (
        <p className="muted" data-testid="review-next-due">
          Next review: {formatDay(item.nextDue)}
        </p>
      )}
      {item.lapsed && (
        <div className="card reteach-offer" data-testid="reteach-offer">
          <p>
            <strong>This one comes back tomorrow.</strong> A short re-teach of what you missed, then one question to check it (about 2 model calls).
          </p>
          <div className="row">
            <button type="button" onClick={props.onReteach} disabled={props.sending}>
              Short re-teach
            </button>
            <button type="button" className="secondary" onClick={props.onNext}>
              Not now
            </button>
          </div>
        </div>
      )}
      {!item.lapsed && (
        <button type="button" onClick={props.onNext} disabled={props.sending}>
          Next
        </button>
      )}
    </div>
  )
}

function Reteach(props: { item: ReviewItemView; streamed: string; sending: boolean; act: (a: () => Promise<SittingView>) => Promise<void>; onOpenPage: (p: CitedPage) => void; onDone: () => void }) {
  const { item } = props
  const text = item.reteach?.markdown ?? (props.streamed !== '' ? props.streamed : null)
  const check = item.reteachAttempt
  return (
    <div className="card question" data-testid="reteach">
      <h2>Re-teach: {item.conceptName}</h2>
      {item.reteach?.outsideSources && <p className="warning">Part of this is not in your materials and comes from general knowledge.</p>}
      {text ? <TutorText text={text} sources={item.sources} onOpenPage={props.onOpenPage} /> : <p className="muted">Writing…</p>}
      {item.error && !item.reteach && <p className="error">{item.error}</p>}
      {item.reteach && item.reteachQuestion && (
        <div className="reteach-check">
          <h3>Check</h3>
          <TutorText text={item.reteachQuestion.stem} sources={item.sources} onOpenPage={props.onOpenPage} />
          {!check ? (
            <AnswerInputs
              idPrefix="reteach-"
              initialAnswer=""
              initialReasoning=""
              sending={props.sending}
              onDraft={null}
              onSubmit={(answer, reasoning, skipped) => void props.act(async () => unwrap(await api['reviews:reteachAnswer']({ itemId: item.id, answer, reasoning, skipped })))}
            />
          ) : (
            <AttemptResult attempt={check} item={item} sending={props.sending} act={props.act} onOpenPage={props.onOpenPage} />
          )}
        </div>
      )}
      {item.lessonExplanation && (
        <div className="card explanation" data-testid="lesson-explanation">
          <p className="muted">Not yet. Here is the lesson’s explanation again; this concept comes back tomorrow.</p>
          <TutorText text={item.lessonExplanation} sources={item.sources} onOpenPage={props.onOpenPage} />
        </div>
      )}
      {(check?.status === 'graded' || !item.reteachQuestion) && (
        <button type="button" onClick={props.onDone}>
          Done
        </button>
      )}
    </div>
  )
}

function Summary({ sitting, onReteach, onBack }: { sitting: SittingView; onReteach: (itemId: number) => void; onBack: () => void }) {
  const verdict = (i: ReviewItemView) => i.attempt?.grades[i.attempt.grades.length - 1]?.verdict
  return (
    <div className="card" data-testid="review-summary">
      <h2>Done for now</h2>
      <ul className="review-summary">
        {sitting.items.map((i) => (
          <li key={i.id} className="row">
            <span className="grow">
              {i.conceptName} <span className="muted">· {i.unitTitle}</span>
            </span>
            <span>{verdict(i) === 'correct' ? 'Recalled' : verdict(i) === 'partial' ? 'Partly' : verdict(i) === 'incorrect' ? 'Missed' : (i.error ?? 'Grading…')}</span>
            <span className="muted">{i.nextDue ? `next ${formatDay(i.nextDue)}` : ''}</span>
            {i.lapsed && !i.reteachAttempt && (
              <button type="button" className="secondary small" onClick={() => onReteach(i.id)}>
                Re-teach
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" onClick={onBack}>
        Back to Learn
      </button>
    </div>
  )
}
