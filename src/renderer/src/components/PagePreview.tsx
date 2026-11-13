import { useEffect, useState } from 'react'
import { api, formatPages, messageOf } from '../lib'

/** Shows one page of a material as an image, with a caption and a close button. */
export function PagePreview({ materialId, page, label, fileName, onClose }: { materialId: number; page: number; label: string | null; fileName: string; onClose: () => void }) {
  const [state, setState] = useState<{ src: string | null; error: string | null }>({ src: null, error: null })

  useEffect(() => {
    let cancelled = false
    api['materials:renderPage']({ materialId, pageIndex: page }).then(
      (r) => {
        if (cancelled) return
        if (!r.ok) setState({ src: null, error: r.error })
        else setState({ src: r.value, error: r.value ? null : 'Slides cannot be shown as images. Export the deck to PDF to see them.' })
      },
      (e: unknown) => !cancelled && setState({ src: null, error: messageOf(e) })
    )
    return () => {
      cancelled = true
      setState({ src: null, error: null })
    }
  }, [materialId, page])

  const ref = { index: page, label }
  return (
    <figure className="preview">
      {state.src && <img src={state.src} alt={`Page ${label ?? page} of ${fileName}`} />}
      {state.error && <p className="error">{state.error}</p>}
      {!state.src && !state.error && <p className="muted">Rendering…</p>}
      <figcaption className="row">
        <span className="grow muted">
          {fileName}, {formatPages(ref, ref)}
        </span>
        <button type="button" className="secondary small" onClick={onClose}>
          Close
        </button>
      </figcaption>
    </figure>
  )
}
