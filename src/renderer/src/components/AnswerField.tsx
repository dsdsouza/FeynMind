import type { KeyboardEvent, ReactNode } from 'react'

/**
 * A labelled text area for an answer or the learner's reasoning. Ctrl+Enter (Cmd+Enter on a Mac)
 * submits. `extra` is shown under the field (hints, the microphone).
 */
export function AnswerField({
  id,
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  rows = 5,
  extra
}: {
  id: string
  label: ReactNode
  value: string
  onChange: (text: string) => void
  onSubmit: () => void
  placeholder: string
  rows?: number
  extra?: ReactNode
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSubmit()
  }
  return (
    <div className="answer-field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} placeholder={placeholder} />
      {extra}
    </div>
  )
}
