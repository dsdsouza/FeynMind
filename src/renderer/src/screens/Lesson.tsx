import { useEffect, useRef, useState } from 'react'
import type { UsageSummary } from '../../../shared/knowledge'
import type { AttemptView, GradeView, LessonStep, LessonView } from '../../../shared/tutor'
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
const DRAFT_DELAY_MS = 800

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
        {STEPS.map((s) => (
          <li key={s.step} className={s.step === step ? 'current' : ''} aria-current={s.step === step ? 'step' : undefined}>
            {s.label}
          </li>
        ))}
      </ol>
      <div className="row lesson-status">
        <label className="grow">
          Mastery{' '}
          <meter min={0} max={1} low={0.3} high={0.6} optimum={1} value={view.mastery.p} data-testid="mastery" data-value={view.mastery.p.toFixed(3)} />{' '}
          <span aria-live="polite">{view.mastery.mastered ? 'mastered' : `${Math.round(view.mastery.p * 100)}%`}</span>
        </label>
        {usage && (
          <span className="muted" data-testid="session-total">
            This course: {usage.calls} calls{usage.callCap !== null ? ` of ${usage.callCap}` : ''}, {formatTokens(usage.inputTokens + usage.outputTokens)} tokens
            {usage.price ? `, ${formatCost(usage.costUsd)}` : ''}
          </span>
        )}
      </div>
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

          {view.question && step !== 'explain' && step !== 'done' && (
            <QuestionCard key={view.question.id} view={view} sending={sending} onOpenPage={open} act={act} />
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
  const [answer, setAnswer] = useState(view.draft)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lessonId = view.lessonId

  // The draft is saved shortly after typing stops, so closing the app keeps it.
  function onType(text: string) {
    setAnswer(text)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void api['lesson:draft']({ lessonId, text }), DRAFT_DELAY_MS)
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  if (!question) return null
  const submit = (skipped: boolean) => {
    if (timer.current) clearTimeout(timer.current)
    void act(async () => unwrap(await api['lesson:answer']({ lessonId, questionId: question.id, answer, skipped })))
  }
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
        <>
          <label htmlFor="answer">Your answer</label>
          <textarea
            id="answer"
            rows={5}
            value={answer}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && answer.trim() !== '') submit(false)
            }}
            placeholder="Type your answer. Use $...$ for math if you like."
          />
          <div className="row">
            <button type="button" onClick={() => submit(false)} disabled={sending || answer.trim() === ''}>
              Submit (Ctrl+Enter)
            </button>
            <button type="button" className="secondary" onClick={() => submit(true)} disabled={sending}>
              I don’t know
            </button>
          </div>
        </>
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
      {attempt.status === 'saved' && !view.blocked && (
        <p className="muted" role="status">
          Saved. Grading…
        </p>
      )}
      <div className={attempt.grades.length > 1 ? 'grades two' : 'grades'}>
        {attempt.grades.map((g) => (
          <GradeCard key={g.pass} grade={g} view={view} onOpenPage={onOpenPage} />
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

function GradeCard({ grade, view, onOpenPage }: { grade: GradeView; view: LessonView; onOpenPage: (p: CitedPage) => void }) {
  return (
    <div className={`grade grade-${grade.verdict}`} data-testid="grade">
      <p>
        <strong>{VERDICT_LABEL[grade.verdict]}</strong>
        {grade.pass === 2 && <span className="muted"> · second grading, after your objection</span>}
      </p>
      {grade.outsideSources && <p className="warning">Your materials do not cover this, so it was graded from general knowledge.</p>}
      {grade.assessment && (
        <div className="muted">
          <TutorText text={grade.assessment} sources={view.sources} onOpenPage={onOpenPage} />
        </div>
      )}
      <div data-testid="grade-reason">
        <TutorText text={grade.reason} sources={view.sources} onOpenPage={onOpenPage} />
      </div>
      {grade.feedback && <TutorText text={grade.feedback} sources={view.sources} onOpenPage={onOpenPage} />}
      {grade.criteria.length > 0 && (
        <ul className="criteria" aria-label="Rubric">
          {grade.criteria.map((c) => (
            <li key={c.id}>
              <span className={`met met-${c.met}`} aria-label={c.met === 'yes' ? 'met' : c.met === 'partly' ? 'partly met' : 'not met'}>
                {MET_LABEL[c.met]}
              </span>{' '}
              <TutorText text={c.text} sources={view.sources} onOpenPage={onOpenPage} inline />
              {c.essential && <span className="muted"> (essential)</span>}
            </li>
          ))}
        </ul>
      )}
      {grade.pages.length > 0 && (
        <p className="muted">
          Based on: <TutorText text={grade.pages.map((p) => `[${p}]`).join(' ')} sources={view.sources} onOpenPage={onOpenPage} inline />
        </p>
      )}
    </div>
  )
}

function CapPrompt({ sessionId, block, onRaised }: { sessionId: number; block: { message: string; calls: number; callCap: number }; onRaised: () => void }) {
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
