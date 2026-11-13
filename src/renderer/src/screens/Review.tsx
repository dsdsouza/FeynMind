import { useEffect, useState } from 'react'
import type { ReviewConcept, UnitReview } from '../../../shared/knowledge'
import { PagePreview } from '../components/PagePreview'
import { api, formatPages, messageOf, unwrap } from '../lib'

type Preview = { materialId: number; page: number; label: string | null; fileName: string }

/** A unit's concepts in learning order, with tools to correct them. */
export function Review({ unitId, onBack }: { unitId: number; onBack: () => void }) {
  const [review, setReview] = useState<UnitReview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)

  useEffect(() => {
    let cancelled = false
    api['concepts:review']({ unitId }).then(
      (r) => !cancelled && (r.ok ? setReview(r.value) : setError(r.error)),
      (e: unknown) => !cancelled && setError(messageOf(e))
    )
    return () => {
      cancelled = true
    }
  }, [unitId])

  async function edit(action: () => Promise<UnitReview>) {
    setError(null)
    try {
      setReview(await action())
    } catch (e) {
      setError(messageOf(e))
    }
  }

  return (
    <section className="screen" aria-labelledby="review-title">
      <p>
        <button type="button" className="secondary small" onClick={onBack}>
          Back to the course
        </button>
      </p>
      <h1 id="review-title">{review ? `Concepts: ${review.unit.title}` : 'Concepts'}</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {review && (
        <>
          <p className="muted">
            {review.concepts.length} concepts in learning order: each comes after its prerequisites. Check that the important ones are here, that none is listed
            twice, and that prerequisites point the right way.
          </p>
          {preview && <PagePreview {...preview} onClose={() => setPreview(null)} />}
          <ol className="concepts">
            {review.concepts.map((c) => (
              <ConceptItem key={c.id} concept={c} review={review} unitId={unitId} onEdit={edit} onPage={setPreview} />
            ))}
          </ol>
        </>
      )}
    </section>
  )
}

function ConceptItem(props: {
  concept: ReviewConcept
  review: UnitReview
  unitId: number
  onEdit: (action: () => Promise<UnitReview>) => Promise<void>
  onPage: (p: Preview) => void
}) {
  const { concept: c, review, unitId, onEdit, onPage } = props
  const [mode, setMode] = useState<'view' | 'rename' | 'merge' | 'link'>('view')
  const [name, setName] = useState(c.name)
  const [definition, setDefinition] = useState(c.definition)
  const [target, setTarget] = useState<number | ''>('')
  const others = review.others.filter((o) => o.id !== c.id)

  const call = (fn: () => ReturnType<(typeof api)['concepts:review']>) => onEdit(async () => unwrap(await fn()))
  const done = () => {
    setMode('view')
    setTarget('')
  }

  return (
    <li id={`concept-${c.id}`} className="card concept" aria-label={c.name}>
      {mode === 'rename' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void call(() => api['concepts:rename']({ unitId, conceptId: c.id, name, definition })).then(done)
          }}
        >
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Definition
            <textarea rows={3} value={definition} onChange={(e) => setDefinition(e.target.value)} />
          </label>
          <div className="row">
            <button type="submit" className="small">
              Save
            </button>
            <button type="button" className="secondary small" onClick={done}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <h2 className="concept-name">
            {c.name}
            {c.edited && <span className="muted small"> (edited)</span>}
          </h2>
          <p>{c.definition}</p>
        </>
      )}

      <p>
        <span className="muted">Prerequisites: </span>
        {c.prerequisites.length === 0 && <span className="muted">none</span>}
        {c.prerequisites.map((p, i) => (
          <span key={p.id}>
            {i > 0 && ', '}
            <a href={`#concept-${p.id}`}>{p.name}</a>
            {p.source === 'user' && <span className="muted"> (yours)</span>}{' '}
            <button
              type="button"
              className="link small"
              aria-label={`Remove ${p.name} as a prerequisite of ${c.name}`}
              onClick={() => void call(() => api['concepts:unlink']({ unitId, conceptId: c.id, prereqId: p.id }))}
            >
              ×
            </button>
          </span>
        ))}
      </p>
      {c.unresolved.length > 0 && <p className="muted">Also needs (not found in your materials): {c.unresolved.join(', ')}</p>}
      {c.removed.length > 0 && (
        <ul className="muted">
          {c.removed.map((r) => (
            <li key={r.id}>
              Removed link to {r.name}: {r.status === 'removed-user' ? 'removed by you.' : r.reason}{' '}
              <button type="button" className="link small" onClick={() => void call(() => api['concepts:link']({ unitId, conceptId: c.id, prereqId: r.id }))}>
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}

      <p>
        <span className="muted">Pages: </span>
        {c.pages.map((p, i) => (
          <span key={`${p.materialId}:${p.page.index}`}>
            {i > 0 && ', '}
            <button type="button" className="link" onClick={() => onPage({ materialId: p.materialId, page: p.page.index, label: p.page.label, fileName: p.fileName })}>
              {formatPages(p.page, p.page)}
            </button>
          </span>
        ))}
      </p>

      {(mode === 'merge' || mode === 'link') && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            if (target === '') return
            const action =
              mode === 'merge'
                ? () => api['concepts:merge']({ unitId, fromId: c.id, intoId: target })
                : () => api['concepts:link']({ unitId, conceptId: c.id, prereqId: target })
            void call(action).then(done)
          }}
        >
          <label className="grow">
            {mode === 'merge' ? `Merge “${c.name}” into` : `Add a prerequisite of “${c.name}”`}
            <select value={target} onChange={(e) => setTarget(e.target.value === '' ? '' : Number(e.target.value))}>
              <option value="">Choose a concept…</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="small" disabled={target === ''}>
            {mode === 'merge' ? 'Merge' : 'Add'}
          </button>
          <button type="button" className="secondary small" onClick={done}>
            Cancel
          </button>
        </form>
      )}

      {mode === 'view' && (
        <div className="row">
          <button type="button" className="secondary small" onClick={() => setMode('rename')}>
            Rename
          </button>
          <button type="button" className="secondary small" onClick={() => setMode('merge')}>
            Merge…
          </button>
          <button type="button" className="secondary small" onClick={() => setMode('link')}>
            Add prerequisite…
          </button>
          <button
            type="button"
            className="secondary small"
            onClick={() => {
              if (window.confirm(`Delete “${c.name}”? Its links go with it.`)) void call(() => api['concepts:delete']({ unitId, conceptId: c.id }))
            }}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  )
}
