import { useEffect, useState } from 'react'
import type { DiagnosticState } from '../../../shared/tutor'
import { TutorText } from '../components/TutorText'
import { api, messageOf, unwrap } from '../lib'

const noPages = () => undefined

/** One multiple-choice question at a time. Keys 1–4 choose an answer, 0 is "I don't know". */
export function Diagnostic({ initial, onDone }: { initial: DiagnosticState; onDone: () => void }) {
  const [state, setState] = useState(initial)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const question = state.question

  async function choose(choice: number | null) {
    if (!question || sending) return
    setSending(true)
    setError(null)
    try {
      setState(unwrap(await api['diagnostic:answer']({ diagnosticId: state.id, questionId: question.questionId, choice })))
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setSending(false)
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!question || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return
      if (event.key === '0') void choose(null)
      const n = Number(event.key)
      if (n >= 1 && n <= question.choices.length) void choose(n - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const title = state.kind === 'confirm' ? `Quick check: ${state.unitTitle ?? ''}` : 'Diagnostic'
  return (
    <section className="screen" aria-labelledby="quiz-title">
      <h1 id="quiz-title">{title}</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {question ? (
        <div className="card" aria-live="polite">
          <p className="muted">
            Question {question.number} of at most {question.max} · {question.conceptName}
          </p>
          <TutorText text={question.stem} sources={[]} onOpenPage={noPages} />
          <div className="choices" role="group" aria-label="Answers">
            {question.choices.map((choice, i) => (
              <button key={i} type="button" className="secondary choice" disabled={sending} onClick={() => void choose(i)}>
                <span className="choice-key">{i + 1}</span>
                <TutorText text={choice} sources={[]} onOpenPage={noPages} inline />
              </button>
            ))}
            <button type="button" className="secondary choice" disabled={sending} onClick={() => void choose(null)}>
              <span className="choice-key">0</span> I don’t know
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <h2>{state.kind === 'confirm' ? (state.outcome === 'confirmed' ? 'Confirmed: you know this unit.' : 'Not confirmed this time.') : 'Done.'}</h2>
          <p>{state.kind === 'confirm' ? (state.outcome === 'confirmed' ? 'Each concept still gets a short lesson, which can skip ahead.' : 'Your standing stays as it was. The lessons will fill the gaps.') : 'Your path now shows where you stand.'}</p>
          <ol className="results">
            {state.results.map((r, i) => (
              <li key={i} className={r.chosen === r.answerIndex ? 'success' : ''}>
                <TutorText text={r.stem} sources={[]} onOpenPage={noPages} />
                <p>
                  {r.chosen === r.answerIndex ? 'Right: ' : r.chosen === null ? 'You did not know. The answer: ' : 'The answer: '}
                  <TutorText text={r.choices[r.answerIndex] ?? ''} sources={[]} onOpenPage={noPages} inline />
                </p>
                <TutorText text={r.why} sources={[]} onOpenPage={noPages} />
              </li>
            ))}
          </ol>
          <button type="button" onClick={onDone}>
            See your path
          </button>
        </div>
      )}
      {question && (
        <button type="button" className="link" onClick={onDone}>
          Leave for now (your answers are kept)
        </button>
      )}
    </section>
  )
}
