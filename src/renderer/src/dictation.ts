import { useEffect, useRef, useState, type RefObject } from 'react'
import { insertTranscript, type DictationStatus } from '../../shared/dictation'
import { api, messageOf, unwrap } from './lib'
import { microphoneError, startRecorder, type Recorder } from './recorder'

// Dictation state for the lesson screen: the background process's status, and one recording at a
// time into one of the answer fields.

/** Longest recording, in seconds; the background process accepts no more. */
const MAX_SECONDS = 300
export const DICTATION_SHORTCUT = 'Ctrl+Shift+Space'

/** The dictation status from the background process, kept current by its events. */
export function useDictationStatus(): DictationStatus | null {
  const [status, setStatus] = useState<DictationStatus | null>(null)
  useEffect(() => {
    let live = true
    void api['dictation:status']().then((r) => {
      if (live && r.ok) setStatus(r.value)
    })
    const off = api.on('dictation:status', setStatus)
    return () => {
      live = false
      off()
    }
  }, [])
  return status
}

export interface DictationTarget {
  ref: RefObject<HTMLTextAreaElement | null>
  value: string
  setValue: (text: string) => void
}

export type DictationPhase = 'idle' | 'preparing' | 'listening' | 'transcribing'

/**
 * Records into one field at a time. The text is inserted where the cursor was when recording
 * started; the field is read-only while listening and transcribing, then editable again.
 */
export function useDictation<F extends string>(targets: Record<F, DictationTarget>) {
  const status = useDictationStatus()
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [field, setField] = useState<F | null>(null)
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [needModel, setNeedModel] = useState(false)
  const session = useRef<{ recordingId: number; recorder: Recorder | null; field: F; start: number; end: number; timer: ReturnType<typeof setInterval> | null } | null>(null)
  const latest = useRef(targets)
  latest.current = targets

  const model = status?.models.find((m) => m.id === status.selected)

  useEffect(
    () => () => {
      const s = session.current
      if (!s) return
      s.recorder?.stop()
      if (s.timer) clearInterval(s.timer)
      void api['dictation:cancel']({ recordingId: s.recordingId })
    },
    []
  )

  async function start(target: F) {
    setError(null)
    setNotice(null)
    if (model?.state !== 'ready') {
      setNeedModel(true)
      return
    }
    setNeedModel(false)
    const el = latest.current[target].ref.current
    const len = latest.current[target].value.length
    const focused = el !== null && document.activeElement === el
    const startAt = focused ? el.selectionStart : len
    const endAt = focused ? el.selectionEnd : len
    setField(target)
    setPhase('preparing')
    try {
      const mic = unwrap(await api['dictation:prepareMic']())
      if (!mic.granted) throw new Error(mic.message ?? 'Microphone access was not granted.')
      const { recordingId } = unwrap(await api['dictation:start']())
      session.current = { recordingId, recorder: null, field: target, start: startAt, end: endAt, timer: null }
      try {
        session.current.recorder = await startRecorder(
          (samples) => void api['dictation:audio']({ recordingId, samples }),
          (l) => setLevel(l)
        )
      } catch (e) {
        void api['dictation:cancel']({ recordingId })
        session.current = null
        throw new Error(microphoneError(e), { cause: e })
      }
      const began = Date.now()
      setSeconds(0)
      session.current.timer = setInterval(() => {
        const s = Math.floor((Date.now() - began) / 1000)
        setSeconds(s)
        if (s >= MAX_SECONDS) {
          setNotice('Recording stops after five minutes.')
          void stop()
        }
      }, 250)
      setPhase('listening')
    } catch (e) {
      setError(messageOf(e))
      setPhase('idle')
      setField(null)
    }
  }

  async function stop() {
    const s = session.current
    if (!s || !s.recorder) return
    s.recorder.stop()
    s.recorder = null
    if (s.timer) clearInterval(s.timer)
    setLevel(0)
    setPhase('transcribing')
    try {
      const { text } = unwrap(await api['dictation:stop']({ recordingId: s.recordingId }))
      if (text === '') setNotice('No speech was heard. Check the microphone and try again.')
      else {
        const target = latest.current[s.field]
        const result = insertTranscript(target.value, s.start, s.end, text)
        target.setValue(result.value)
        requestAnimationFrame(() => {
          const el = target.ref.current
          if (!el) return
          el.focus()
          el.setSelectionRange(result.cursor, result.cursor)
        })
      }
    } catch (e) {
      setError(messageOf(e))
    } finally {
      session.current = null
      setPhase('idle')
      setField(null)
    }
  }

  function cancel() {
    const s = session.current
    if (!s) return
    s.recorder?.stop()
    if (s.timer) clearInterval(s.timer)
    void api['dictation:cancel']({ recordingId: s.recordingId })
    session.current = null
    setLevel(0)
    setPhase('idle')
    setField(null)
    setNotice('Recording discarded.')
  }

  function toggle(target: F) {
    if (phase === 'listening') void stop()
    else if (phase === 'idle') void start(target)
  }

  return { status, model, phase, field, seconds, level, error, notice, needModel, toggle, cancel, busy: phase !== 'idle', dismissModel: () => setNeedModel(false) }
}
