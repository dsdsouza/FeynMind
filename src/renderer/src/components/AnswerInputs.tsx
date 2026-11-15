import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { DICTATION_SHORTCUT, useDictation } from '../dictation'
import { AnswerField } from './AnswerField'
import { DictationState, MicButton, ModelPrompt, OsDictationHint } from './Dictation'

const DRAFT_DELAY_MS = 800

/**
 * The answer and "Your thinking" fields, each typed or dictated, with Submit and "I don't know".
 * Ctrl+Shift+Space starts and stops dictation in the focused field (the thinking field when
 * neither has focus); Esc discards it. Drafts are saved shortly after typing stops, so closing the
 * app loses nothing. Used by lessons, reviews and re-teach checks.
 */
export function AnswerInputs(props: {
  /** Distinguishes the fields' ids when more than one form could be on the page. */
  idPrefix?: string
  initialAnswer: string
  initialReasoning: string
  sending: boolean
  onDraft: ((field: 'answer' | 'reasoning', text: string) => void) | null
  onSubmit: (answer: string, reasoning: string, skipped: boolean) => void
  /** Extra buttons beside Submit (a hint, say). */
  extra?: React.ReactNode
}) {
  const prefix = props.idPrefix ?? ''
  const [answer, setAnswer] = useDraft('answer', props.initialAnswer, props.onDraft)
  const [reasoning, setReasoning] = useDraft('reasoning', props.initialReasoning, props.onDraft)
  const answerRef = useRef<HTMLTextAreaElement | null>(null)
  const reasoningRef = useRef<HTMLTextAreaElement | null>(null)
  const dictation = useDictation({
    answer: { ref: answerRef, value: answer.text, setValue: setAnswer },
    reasoning: { ref: reasoningRef, value: reasoning.text, setValue: setReasoning }
  })

  const submit = (skipped: boolean) => {
    if (dictation.busy) return
    if (!skipped && answer.text.trim() === '') return
    answer.cancel()
    reasoning.cancel()
    props.onSubmit(answer.text, reasoning.text, skipped)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space') {
      e.preventDefault()
      dictation.toggle(document.activeElement === answerRef.current ? 'answer' : document.activeElement === reasoningRef.current ? 'reasoning' : (dictation.field ?? 'reasoning'))
    } else if (e.key === 'Escape' && dictation.phase === 'listening') {
      e.preventDefault()
      dictation.cancel()
    }
  }

  const mic = (field: 'answer' | 'reasoning', label: string) => (
    <MicButton label={label} active={dictation.field === field && dictation.phase === 'listening'} disabled={dictation.busy && !(dictation.field === field && dictation.phase === 'listening')} onClick={() => dictation.toggle(field)} />
  )

  return (
    <div onKeyDown={onKeyDown}>
      <div className="answer-fields">
        <AnswerField
          id={`${prefix}answer`}
          ref={answerRef}
          label="Your answer"
          value={answer.text}
          onChange={setAnswer}
          onSubmit={() => submit(false)}
          readOnly={dictation.field === 'answer'}
          placeholder="Type or dictate your answer. Use $...$ for math if you like."
          extra={mic('answer', 'answer')}
        />
        <AnswerField
          id={`${prefix}reasoning`}
          ref={reasoningRef}
          label={
            <>
              Your thinking <span className="muted">(optional)</span>
            </>
          }
          value={reasoning.text}
          onChange={setReasoning}
          onSubmit={() => submit(false)}
          readOnly={dictation.field === 'reasoning'}
          placeholder="Explain how you got there, out loud or typed. It is graded with your answer."
          extra={mic('reasoning', 'thinking')}
        />
      </div>
      <DictationState phase={dictation.phase} seconds={dictation.seconds} level={dictation.level} onStop={() => dictation.toggle(dictation.field ?? 'reasoning')} onCancel={dictation.cancel} />
      {dictation.status?.engine === 'restarting' && (
        <p className="warning" role="status" data-testid="dictation-restarting">
          Speech recognition stopped unexpectedly and is restarting. What you said is kept and will be transcribed.
        </p>
      )}
      {dictation.error && (
        <p className="error" role="alert" data-testid="dictation-error">
          {dictation.error}
        </p>
      )}
      {dictation.notice && (
        <p className="muted" role="status">
          {dictation.notice}
        </p>
      )}
      {dictation.needModel && dictation.status && <ModelPrompt status={dictation.status} onClose={dictation.dismissModel} />}
      <p className="muted os-hint">
        Dictate with the microphone buttons or {DICTATION_SHORTCUT} (Esc discards). Speech is turned into text on this computer; audio is never stored or sent.
      </p>
      {dictation.status && <OsDictationHint platform={dictation.status.platform} />}
      <div className="row">
        <button type="button" onClick={() => submit(false)} disabled={props.sending || dictation.busy || answer.text.trim() === ''}>
          Submit (Ctrl+Enter)
        </button>
        <button type="button" className="secondary" onClick={() => submit(true)} disabled={props.sending || dictation.busy}>
          I don’t know
        </button>
        {props.extra}
      </div>
    </div>
  )
}

/**
 * A field's text, saved as a draft shortly after it stops changing. `cancel` drops a pending save
 * (before submitting).
 */
function useDraft(field: 'answer' | 'reasoning', initial: string, save: ((field: 'answer' | 'reasoning', text: string) => void) | null): [{ text: string; cancel: () => void }, (text: string) => void] {
  const [text, setText] = useState(initial)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const update = (next: string) => {
    setText(next)
    cancel()
    if (save) timer.current = setTimeout(() => save(field, next), DRAFT_DELAY_MS)
  }
  return [{ text, cancel }, update]
}
