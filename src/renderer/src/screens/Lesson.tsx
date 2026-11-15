import { useEffect, useState } from 'react'
import type { SourceRef } from '../../../shared/citations'
import { reasonText } from '../../../shared/reviews'
import type { UsageSummary } from '../../../shared/knowledge'
import { masteryHint, type AttemptView, type GradeView, type LessonStep, type LessonView, type ReasoningJudgment } from '../../../shared/tutor'
import { AnswerInputs } from '../components/AnswerInputs'
import { PagePreview } from '../components/PagePreview'
import { TutorText, type CitedPage } from '../components/TutorText'
import { api, formatCost, formatTokens, messageOf, unwrap } from '../lib'
import { EstimateLine } from './Learn'

const STEPS: { step: LessonStep; label: string }[] = [
  { step: 'opening', label: 'Question first' },
  { step: 'explain', label: 'Explanation' },
  { step: 'guided', label: 'Guided' },
  { step: 'partial', label: 'Partial' },
  { step: 'unaided', label: 'On your own' },
  { step: 'done', label: 'Mastered' }
]

const KIND_LABEL = { opening: 'Before we start', guided: 'Guided practice', partial: 'Practice with a start', unaided: 'On your own' } as const
const VERDICT_LABEL = { correct: 'Correct', partial: 'Partly correct', incorrect: 'Not yet' } as const
const MET_LABEL = { yes: '✓', partly: '½', no: '✗' } as const
const REASONING_LABEL: Record<ReasoningJudgment, string> = { sound: 'Your thinking holds up', flawed: 'Your thinking has a flaw', none: 'No reasoning to judge in your thinking' }
/** Read out after each step's name; the look alone must not carry the state. */
const STEP_STATE_TEXT = { done: ', done', current: ', current step', skipped: ', skipped', upcoming: '' } as const

export function Lesson({ sessionId, initial, usage, onBack, onOpen }: { sessionId: number; initial: LessonView; usage: UsageSummary | null; onBack: () => void; onOpen: (conceptId: number) => void }) {
  const [view, setView] = useState(initial)
  const [streamed, setStreamed] = useState('')
  const [preview, setPreview] = useState<CitedPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const lessonId = initial.lessonId

  useEffect(() => {
    const offLesson = api.on('tutor:lesson', (v) => {
      if (v.lessonId !== lessonId) return
      setView(v)
      if (v.explanation) setStreamed('')
    })
    const offStream = api.on('tutor:stream', (e) => {
      if (e.lessonId !== lessonId) return
      setStreamed((s) => (e.kind === 'reset' ? '' : s + e.text))
    })
    return () => {
      offLesson()
      offStream()
    }
  }, [lessonId])

  async function act(action: () => Promise<LessonView>) {
    setSending(true)
    setError(null)
    try {
      setView(await action())
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setSending(false)
    }
  }

  const step = view.step
  const explanation = view.explanation?.markdown ?? (streamed !== '' ? streamed : null)
  const showExplanation = explanation !== null && step !== 'opening'
  const open = (page: CitedPage) => setPreview(page)

  return (
    <section className="screen lesson" aria-labelledby="lesson-title">
      <div className="row">
        <button type="button" className="link" onClick={onBack}>
          ← Your path
        </button>
      </div>
      <h1 id="lesson-title">{view.concept.name}</h1>
      <p className="muted">
        {view.concept.unitTitle}
        {view.concept.prerequisites.length > 0 && ` · builds on ${view.concept.prerequisites.join(', ')}`}
      </p>
      <ol className="steps" aria-label="Lesson steps">
        {STEPS.map((s) => {
          const state = view.steps[s.step]
          return (
            <li key={s.step} className={`step-${state}`} aria-current={state === 'current' ? 'step' : undefined} data-testid={`step-${s.step}`} data-state={state}>
              {state === 'done' && <span aria-hidden="true">✓ </span>}
              {s.label}
              <span className="visually-hidden">{STEP_STATE_TEXT[state]}</span>
            </li>
          )
        })}
      </ol>
      <div className="row lesson-status">
        <label className="grow">
          Mastery{' '}
          <meter min={0} max={1} low={0.3} high={0.6} optimum={1} value={view.mastery.shown} data-testid="mastery" data-value={view.mastery.shown.toFixed(3)} />{' '}
          <span aria-live="polite">{view.mastery.mastered ? 'mastered' : `${Math.round(view.mastery.shown * 100)}%`}</span>
        </label>
        {usage && (
          <span className="muted" data-testid="session-total">
            This course: {usage.calls} calls{usage.callCap !== null ? ` of ${usage.callCap}` : ''}, {formatTokens(usage.inputTokens + usage.outputTokens)} tokens
            {usage.price ? `, ${formatCost(usage.costUsd)}` : ''}
          </span>
        )}
      </div>
      {masteryHint(view.mastery) && (
        <p className="mastery-hint" data-testid="mastery-hint" aria-live="polite">
          {masteryHint(view.mastery)}
        </p>
      )}
      {view.estimate.calls > 0 && <EstimateLine estimate={view.estimate} what="The rest of this lesson" />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {view.blocked?.kind === 'cap' && <CapPrompt sessionId={sessionId} block={view.blocked} onRaised={() => void act(async () => unwrap(await api['lesson:retry']({ lessonId })))} />}
      {view.blocked?.kind === 'error' && (
        <div className="card warning-card" role="alert">
          <p>{view.blocked.message}</p>
          <p className="muted">Your answers are saved.</p>
          <button type="button" onClick={() => void act(async () => unwrap(await api['lesson:retry']({ lessonId })))} disabled={sending}>
            Try again
          </button>
        </div>
      )}
      {view.questionsOutsideSources && <p className="warning">Your materials do not cover this concept well, so these questions come from general knowledge of the subject.</p>}

      <div className={preview ? 'lesson-body with-preview' : 'lesson-body'}>
        <div className="lesson-main">
          {showExplanation && (
            <div className="card explanation" aria-live="polite" aria-busy={view.explaining}>
              {view.explanation?.outsideSources && <p className="warning">Part of this is not in your materials and comes from general knowledge (marked below).</p>}
              <TutorText text={explanation} sources={view.sources} onOpenPage={open} />
              {view.explaining && <p className="muted">Writing…</p>}
            </div>
          )}
          {step === 'explain' && !explanation && !view.blocked && <p className="muted">Writing the explanation…</p>}
          {step === 'explain' && view.explanation && (
            <button type="button" onClick={() => void act(async () => unwrap(await api['lesson:continue']({ lessonId, fastTrack: false })))} disabled={sending}>
              Start practising
            </button>
          )}

          {view.interleave ? (
            <InterleaveCard key={view.interleave.itemId} view={view} sending={sending} onOpenPage={open} act={act} />
          ) : (
            view.question &&
            step !== 'explain' &&
            step !== 'done' && <QuestionCard key={view.question.id} view={view} sending={sending} onOpenPage={open} act={act} />
          )}

          {step === 'done' && (
            <div className="card">
              <h2>Mastered.</h2>
              <p>You answered on your own and the estimate passed the mastery threshold.</p>
              {view.next ? (
                <button type="button" onClick={() => onOpen(view.next?.conceptId ?? 0)}>
                  Next: {view.next.name}
                </button>
              ) : (
                <button type="button" onClick={onBack}>
                  Back to your path
                </button>
              )}
            </div>
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

function QuestionCard({ view, sending, onOpenPage, act }: { view: LessonView; sending: boolean; onOpenPage: (p: CitedPage) => void; act: (a: () => Promise<LessonView>) => Promise<void> }) {
  const question = view.question
  const attempt = view.attempt
  const lessonId = view.lessonId

  if (!question) return null
  const proceed = (fastTrack: boolean) => void act(async () => unwrap(await api['lesson:continue']({ lessonId, fastTrack })))

  return (
    <div className="card question" aria-labelledby="question-title">
      <h2 id="question-title">
        {KIND_LABEL[question.kind]}
        {question.kind === 'unaided' && ` (${question.number})`}
      </h2>
      <TutorText text={question.stem} sources={view.sources} onOpenPage={onOpenPage} />
      {question.scaffold && (
        <div className="scaffold">
          <p className="muted">Fill in the blanks:</p>
          <TutorText text={question.scaffold} sources={view.sources} onOpenPage={onOpenPage} />
        </div>
      )}
      {!attempt ? (
        <AnswerForm key={question.id} view={view} questionId={question.id} sending={sending} act={act} />
      ) : (
        <AttemptCard attempt={attempt} view={view} sending={sending} onOpenPage={onOpenPage} act={act} />
      )}
      {attempt?.status === 'graded' && !attempt.contestPending && (
        <div className="row">
          {view.canFastTrack && (
            <button type="button" onClick={() => proceed(true)} disabled={sending}>
              You know this: skip to a question on your own
            </button>
          )}
          {view.canMoreQuestions ? (
            <button type="button" onClick={() => void act(async () => unwrap(await api['lesson:more']({ lessonId })))} disabled={sending}>
              More questions (one model call)
            </button>
          ) : (
            <button type="button" className={view.canFastTrack ? 'secondary' : ''} onClick={() => proceed(false)} disabled={sending}>
              {view.step === 'opening' ? 'Show me the explanation' : view.mastery.mastered ? 'Finish' : 'Next question'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The answer and "Your thinking" fields of the current lesson question. */
function AnswerForm({ view, questionId, sending, act }: { view: LessonView; questionId: number; sending: boolean; act: (a: () => Promise<LessonView>) => Promise<void> }) {
  const lessonId = view.lessonId
  return (
    <AnswerInputs
      initialAnswer={view.draft}
      initialReasoning={view.draftReasoning}
      sending={sending}
      onDraft={(field, text) => void api['lesson:draft']({ lessonId, field, text })}
      onSubmit={(answer, reasoning, skipped) => void act(async () => unwrap(await api['lesson:answer']({ lessonId, questionId, answer, reasoning, skipped })))}
    />
  )
}

/** The question from an earlier concept mixed into the lesson before the first question on your own. */
function InterleaveCard({ view, sending, onOpenPage, act }: { view: LessonView; sending: boolean; onOpenPage: (p: CitedPage) => void; act: (a: () => Promise<LessonView>) => Promise<void> }) {
  const item = view.interleave
  if (!item) return null
  const lessonId = view.lessonId
  const attempt = item.attempt
  return (
    <div className="card question" aria-labelledby="interleave-title" data-testid="interleave">
      <h2 id="interleave-title">A question from earlier</h2>
      <p className="muted">{item.reasons.map(reasonText).join(' · ')}</p>
      <TutorText text={item.stem} sources={[]} onOpenPage={onOpenPage} />
      {!attempt ? (
        <AnswerInputs
          idPrefix="interleave-"
          initialAnswer={item.draft}
          initialReasoning=""
          sending={sending}
          onDraft={(field, text) => void api['reviews:draft']({ itemId: item.itemId, field, text })}
          onSubmit={(answer, reasoning, skipped) => void act(async () => unwrap(await api['lesson:interleaveAnswer']({ lessonId, itemId: item.itemId, answer, reasoning, skipped })))}
        />
      ) : (
        <>
          {item.conceptName && <p className="muted">This was about: {item.conceptName}</p>}
          {attempt.status === 'saved' && (
            <p className="muted" role="status">
              {attempt.error ?? 'Saved. Grading…'}
            </p>
          )}
          {attempt.grades.map((g) => (
            <GradeCard key={g.pass} grade={g} sources={view.sources} onOpenPage={onOpenPage} />
          ))}
          <button type="button" onClick={() => void act(async () => unwrap(await api['lesson:continue']({ lessonId, fastTrack: false })))} disabled={sending}>
            Back to this lesson
          </button>
        </>
      )}
    </div>
  )
}

function AttemptCard({ attempt, view, sending, onOpenPage, act }: { attempt: AttemptView; view: LessonView; sending: boolean; onOpenPage: (p: CitedPage) => void; act: (a: () => Promise<LessonView>) => Promise<void> }) {
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
      {attempt.reasoning !== '' && (
        <>
          <p className="muted">Your thinking:</p>
          <blockquote data-testid="attempt-reasoning">
            <TutorText text={attempt.reasoning} sources={[]} onOpenPage={onOpenPage} />
          </blockquote>
        </>
      )}
      {attempt.status === 'saved' && !view.blocked && (
        <p className="muted" role="status">
          Saved. Grading…
        </p>
      )}
      <div className={attempt.grades.length > 1 ? 'grades two' : 'grades'}>
        {attempt.grades.map((g) => (
          <GradeCard key={g.pass} grade={g} sources={view.sources} onOpenPage={onOpenPage} />
        ))}
      </div>
      {attempt.contestPending && (
        <p className="muted" role="status">
          Your objection is saved. Grading again…
        </p>
      )}
      {attempt.canContest &&
        (contesting ? (
          <div className="contest">
            <label htmlFor="objection">Why is the grade wrong? A second grading will see this. You can contest once.</label>
            <textarea id="objection" rows={3} value={objection} onChange={(e) => setObjection(e.target.value)} />
            <div className="row">
              <button type="button" disabled={sending || objection.trim() === ''} onClick={() => void act(async () => unwrap(await api['lesson:contest']({ attemptId: attempt.id, objection })))}>
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

export function GradeCard({ grade, sources, onOpenPage }: { grade: GradeView; sources: SourceRef[]; onOpenPage: (p: CitedPage) => void }) {
  const reasoning = grade.reasoning
  // Flawed reasoning explains the grade, so it comes before the rubric reason, which can sound like praise.
  const flawed = reasoning?.judgment === 'flawed'
  const reasoningBlock = reasoning && (
    <div className={`reasoning-judgment reasoning-${reasoning.judgment}`} data-testid="grade-reasoning">
      <strong>{REASONING_LABEL[reasoning.judgment]}.</strong>{' '}
      {reasoning.comment && <TutorText text={reasoning.comment} sources={sources} onOpenPage={onOpenPage} inline />}
      {flawed && grade.verdict !== 'incorrect' && (
        <p data-testid="reasoning-cap">
          <strong>Faulty reasoning caps the grade at partly correct, even when the answer is right, so it does not count toward mastery.</strong>
        </p>
      )}
    </div>
  )
  return (
    <div className={`grade grade-${grade.verdict}`} data-testid="grade">
      <p>
        <strong>{VERDICT_LABEL[grade.verdict]}</strong>
        {grade.pass === 2 && <span className="muted"> · second grading, after your objection</span>}
      </p>
      {flawed && reasoningBlock}
      {grade.outsideSources && <p className="warning">Your materials do not cover this, so it was graded from general knowledge.</p>}
      {grade.assessment && (
        <div className="muted">
          <TutorText text={grade.assessment} sources={sources} onOpenPage={onOpenPage} />
        </div>
      )}
      <div data-testid="grade-reason">
        <TutorText text={grade.reason} sources={sources} onOpenPage={onOpenPage} />
      </div>
      {grade.feedback && <TutorText text={grade.feedback} sources={sources} onOpenPage={onOpenPage} />}
      {!flawed && reasoningBlock}
      {grade.criteria.length > 0 && (
        <ul className="criteria" aria-label="Rubric">
          {grade.criteria.map((c) => (
            <li key={c.id}>
              <span className={`met met-${c.met}`} aria-label={c.met === 'yes' ? 'met' : c.met === 'partly' ? 'partly met' : 'not met'}>
                {MET_LABEL[c.met]}
              </span>{' '}
              <TutorText text={c.text} sources={sources} onOpenPage={onOpenPage} inline />
              {c.essential && <span className="muted"> (essential)</span>}
            </li>
          ))}
        </ul>
      )}
      {grade.pages.length > 0 && (
        <p className="muted">
          Based on: <TutorText text={grade.pages.map((p) => `[${p}]`).join(' ')} sources={sources} onOpenPage={onOpenPage} inline />
        </p>
      )}
    </div>
  )
}

export function CapPrompt({ sessionId, block, onRaised }: { sessionId: number; block: { message: string; calls: number; callCap: number }; onRaised: () => void }) {
  const [cap, setCap] = useState(String(block.callCap + 50))
  const [error, setError] = useState<string | null>(null)
  async function raise() {
    setError(null)
    const value = Number(cap)
    if (!Number.isInteger(value) || value <= block.calls) {
      setError(`Enter a whole number above ${block.calls}.`)
      return
    }
    try {
      unwrap(await api['usage:raiseCap']({ sessionId, callCap: value }))
      onRaised()
    } catch (e) {
      setError(messageOf(e))
    }
  }
  return (
    <div className="card warning-card" role="alert" data-testid="cap-prompt">
      <h2>Call cap reached</h2>
      <p>
        This course has used {block.calls} of its {block.callCap} model calls. Your answers are saved and will be graded once you raise the cap.
      </p>
      <div className="row">
        <label htmlFor="cap">New cap</label>
        <input id="cap" type="number" min={block.calls + 1} value={cap} onChange={(e) => setCap(e.target.value)} />
        <button type="button" onClick={() => void raise()}>
          Raise cap and continue
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
