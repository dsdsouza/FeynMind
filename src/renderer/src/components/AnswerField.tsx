import type { KeyboardEvent, ReactNode, Ref } from 'react'

/**
 * A labelled text area for an answer or the learner's reasoning. Ctrl+Enter (Cmd+Enter on a Mac)
 * submits. `extra` is shown under the field (the microphone). Read-only while dictation fills it.
 */
export function AnswerField({
  id,
  ref,
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  readOnly = false,
  rows = 5,
  extra
}: {
  id: string
  ref?: Ref<HTMLTextAreaElement>
  label: ReactNode
  value: string
  onChange: (text: string) => void
  onSubmit: () => void
  placeholder: string
  readOnly?: boolean
  rows?: number
  extra?: ReactNode
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSubmit()
  }
  return (
    <div className="answer-field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} ref={ref} rows={rows} value={value} readOnly={readOnly} aria-busy={readOnly} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} placeholder={placeholder} />
      {extra}
    </div>
  )
}
