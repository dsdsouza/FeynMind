import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  MATCH_END,
  MATCH_START,
  type AddMaterialsResult,
  type MaterialSummary,
  type ModelStatus,
  type PageIssue,
  type PageRef,
  type SearchResponse,
  type SearchResult,
  type Session
} from '../../../shared/ingestion'
import type { Result } from '../../../shared/ipc'

const api = window.feynmind

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

/** "p. 22 (PDF 5)", "pp. 22–23 (PDF 5–6)", or "slide 3" for decks. */
function formatPages(start: PageRef, end: PageRef, kind: 'pdf' | 'pptx' = 'pdf'): string {
  if (kind === 'pptx') return start.index === end.index ? `slide ${start.index}` : `slides ${start.index}–${end.index}`
  const pdf = start.index === end.index ? `PDF ${start.index}` : `PDF ${start.index}–${end.index}`
  if (start.label === null) return start.index === end.index ? `page ${start.index}` : `pages ${start.index}–${end.index}`
  const printed = start.index === end.index || start.label === end.label ? `p. ${start.label}` : `pp. ${start.label}–${end.label ?? '?'}`
  return `${printed} (${pdf})`
}

export function Materials() {
  const [session, setSession] = useState<Session | null>(null)
  const [materials, setMaterials] = useState<MaterialSummary[]>([])
  const [model, setModel] = useState<ModelStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addResult, setAddResult] = useState<AddMaterialsResult | null>(null)

  const refresh = useCallback(async (sessionId: number) => {
    setMaterials(unwrap(await api['materials:list']({ sessionId })))
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const current = unwrap(await api['sessions:current']())
        if (cancelled) return
        setSession(current)
        setModel(unwrap(await api['models:status']()))
        await refresh(current.id)
      } catch (e) {
        if (!cancelled) setError(messageOf(e))
      }
    })()
    const offProgress = api.on('ingestion:progress', (summary) => {
      setMaterials((list) => {
        const index = list.findIndex((m) => m.id === summary.id)
        if (index === -1) return [...list, summary]
        const next = [...list]
        next[index] = summary
        return next
      })
    })
    const offModel = api.on('models:progress', setModel)
    return () => {
      cancelled = true
      offProgress()
      offModel()
    }
  }, [refresh])

  async function addFiles() {
    if (!session) return
    setAdding(true)
    setAddResult(null)
    setError(null)
    try {
      const result = unwrap(await api['materials:add']({ sessionId: session.id }))
      setAddResult(result)
      await refresh(session.id)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setAdding(false)
    }
  }

  return (
    <section className="screen" aria-labelledby="materials-title">
      <h1 id="materials-title">Materials</h1>
      {session && <p className="muted">{session.name}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {model && <ModelBanner status={model} onStatus={setModel} />}

      <div className="card">
        <div className="row">
          <h2 className="grow">Files</h2>
          <button type="button" onClick={() => void addFiles()} disabled={!session || adding}>
            {adding ? 'Adding…' : 'Add files'}
          </button>
        </div>
        <p className="muted">PDF textbooks and PowerPoint (.pptx) decks. Everything is read on this computer.</p>
        {addResult && <AddResultNote result={addResult} />}
        {materials.length === 0 ? (
          <p className="muted">No files yet.</p>
        ) : (
          <ul className="materials" aria-label="Files">
            {materials.map((m) => (
              <MaterialItem key={m.id} material={m} />
            ))}
          </ul>
        )}
      </div>

      {session && <Search sessionId={session.id} kinds={new Map(materials.map((m) => [m.id, m.kind]))} />}
    </section>
  )
}

function ModelBanner({ status, onStatus }: { status: ModelStatus; onStatus: (s: ModelStatus) => void }) {
  async function retry() {
    try {
      onStatus(unwrap(await api['models:retry']()))
    } catch {
      // The status event reports the outcome.
    }
  }
  if (status.state === 'ready' || status.state === 'missing') return null
  if (status.state === 'downloading') {
    return (
      <div className="card" role="status" data-testid="model-status">
        <p>
          Downloading the search model ({status.name}), once: {formatBytes(status.receivedBytes)} of {formatBytes(status.totalBytes)}
        </p>
        <progress max={status.totalBytes} value={status.receivedBytes} aria-label="Search model download" />
      </div>
    )
  }
  return (
    <div className="card" role="status" data-testid="model-status">
      <p className="warning">
        {status.state === 'disabled' ? status.error : `The search model could not be loaded: ${status.error ?? 'unknown error'}.`} Search
        uses keywords only until it is available.
      </p>
      {status.state === 'failed' && (
        <button type="button" className="secondary" onClick={() => void retry()}>
          Try again
        </button>
      )}
    </div>
  )
}

function AddResultNote({ result }: { result: AddMaterialsResult }) {
  return (
    <div role="status" className="add-result">
      {result.added.length > 0 && <p className="success">Added {result.added.join(', ')}.</p>}
      {result.duplicates.length > 0 && <p className="muted">Already added: {result.duplicates.join(', ')}.</p>}
      {result.rejected.map((r) => (
        <p key={r.name} className="error">
          {r.name}: {r.reason}
        </p>
      ))}
    </div>
  )
}

const STAGE_TEXT: Record<MaterialSummary['stage'], string> = {
  queued: 'Waiting',
  reading: 'Reading pages',
  embedding: 'Indexing for search',
  'waiting-for-model': 'Read; waiting for the search model (keyword search works)',
  done: 'Ready',
  failed: 'Failed'
}

function MaterialItem({ material: m }: { material: MaterialSummary }) {
  const [showIssues, setShowIssues] = useState(false)
  const unit = m.kind === 'pptx' ? 'slides' : 'pages'
  const reading = m.stage === 'reading' || m.stage === 'queued'
  const issueCount = m.pagesFailed + m.pagesOcr + m.pagesMathHeavy + m.pagesFigureHeavy
  return (
    <li className="material" data-testid="material">
      <div className="row">
        <strong className="grow">{m.name}</strong>
        <span className="muted">{formatBytes(m.byteSize)}</span>
      </div>
      <p className={m.status === 'failed' ? 'error' : 'muted'} data-testid="material-stage">
        {STAGE_TEXT[m.stage]}
        {m.error ? `: ${m.error}` : ''}
      </p>
      {m.status !== 'failed' && m.status !== 'done' && (
        reading ? (
          <progress max={m.pageCount ?? 1} value={m.pagesDone} aria-label={`${m.name}: ${unit} read`} />
        ) : (
          <progress max={Math.max(1, m.chunkCount)} value={m.chunksEmbedded} aria-label={`${m.name}: passages indexed`} />
        )
      )}
      <p className="muted small" data-testid="material-counts">
        {m.pagesDone} of {m.pageCount ?? '?'} {unit} read · {m.chunksEmbedded} of {m.chunkCount} passages indexed
        {m.pagesFailed > 0 && ` · ${m.pagesFailed} failed`}
        {m.pagesOcr > 0 && ` · ${m.pagesOcr} recognized from images`}
        {m.pagesMathHeavy > 0 && ` · ${m.pagesMathHeavy} math-heavy`}
        {m.pagesFigureHeavy > 0 && ` · ${m.pagesFigureHeavy} figure-heavy`}
      </p>
      {(m.status === 'done' || m.timings.extractMs > 0) && (
        <p className="muted small" data-testid="material-timings">
          Text {formatDuration(m.timings.extractMs)} · recognition {formatDuration(m.timings.ocrMs)} · search index {formatDuration(m.timings.embedMs)}
        </p>
      )}
      {issueCount > 0 && (
        <button type="button" className="link" aria-expanded={showIssues} onClick={() => setShowIssues((v) => !v)}>
          {showIssues ? 'Hide' : 'Show'} pages that failed or were flagged
        </button>
      )}
      {showIssues && <PageIssues material={m} />}
    </li>
  )
}

function PageIssues({ material }: { material: MaterialSummary }) {
  const [issues, setIssues] = useState<PageIssue[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ page: PageIssue; src: string | null; error: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    api['materials:issues']({ materialId: material.id }).then(
      (r) => !cancelled && (r.ok ? setIssues(r.value) : setError(r.error)),
      (e: unknown) => !cancelled && setError(messageOf(e))
    )
    return () => {
      cancelled = true
    }
  }, [material.id, material.pagesDone])

  async function show(page: PageIssue) {
    setPreview({ page, src: null, error: null })
    try {
      const src = unwrap(await api['materials:renderPage']({ materialId: material.id, pageIndex: page.pageIndex }))
      setPreview({ page, src, error: src ? null : 'Slides cannot be shown as images. Export the deck to PDF to see them.' })
    } catch (e) {
      setPreview({ page, src: null, error: messageOf(e) })
    }
  }

  if (error) return <p className="error">{error}</p>
  if (!issues) return <p className="muted">Loading…</p>
  return (
    <div className="issues">
      <ul aria-label={`Pages of ${material.name} that failed or were flagged`}>
        {issues.map((p) => (
          <li key={p.pageIndex} className="row">
            <span className="grow">
              {formatPages({ index: p.pageIndex, label: p.pageLabel }, { index: p.pageIndex, label: p.pageLabel }, material.kind)}:{' '}
              {[
                p.failed && `failed (${p.error ?? 'unknown error'})`,
                p.ocr && `recognized from image${p.ocrConfidence !== null ? ` (${p.ocrConfidence}% confidence)` : ''}`,
                p.mathHeavy && 'math-heavy',
                p.figureHeavy && 'figure-heavy'
              ]
                .filter(Boolean)
                .join(', ')}
            </span>
            {material.kind === 'pdf' && (
              <button type="button" className="secondary small" onClick={() => void show(p)}>
                View
              </button>
            )}
          </li>
        ))}
      </ul>
      {preview && (
        <figure className="preview">
          {preview.src && <img src={preview.src} alt={`Page ${preview.page.pageLabel ?? preview.page.pageIndex} of ${material.name}`} />}
          {preview.error && <p className="error">{preview.error}</p>}
          {!preview.src && !preview.error && <p className="muted">Rendering…</p>}
          <figcaption className="row">
            <span className="grow muted">
              {formatPages({ index: preview.page.pageIndex, label: preview.page.pageLabel }, { index: preview.page.pageIndex, label: preview.page.pageLabel })}
            </span>
            <button type="button" className="secondary small" onClick={() => setPreview(null)}>
              Close
            </button>
          </figcaption>
        </figure>
      )}
    </div>
  )
}

function Search({ sessionId, kinds }: { sessionId: number; kinds: Map<number, 'pdf' | 'pptx'> }) {
  const [query, setQuery] = useState('')
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'done'; value: SearchResponse; query: string }>({
    kind: 'idle'
  })

  async function submit(event: FormEvent) {
    event.preventDefault()
    const q = query.trim()
    if (!q) return
    setState({ kind: 'loading' })
    try {
      setState({ kind: 'done', value: unwrap(await api['search:query']({ sessionId, query: q })), query: q })
    } catch (e) {
      setState({ kind: 'error', message: messageOf(e) })
    }
  }

  return (
    <div className="card">
      <h2>Search</h2>
      <form className="row" onSubmit={(e) => void submit(e)} role="search">
        <label htmlFor="search" className="visually-hidden">
          Search your materials
        </label>
        <input id="search" type="search" placeholder="Ask about your materials" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" disabled={state.kind === 'loading' || query.trim() === ''}>
          {state.kind === 'loading' ? 'Searching…' : 'Search'}
        </button>
      </form>
      <div aria-live="polite">
        {state.kind === 'error' && <p className="error">{state.message}</p>}
        {state.kind === 'done' && (
          <>
            {state.value.mode === 'keyword' && <p className="muted small">Keyword search only: the search model is not ready yet.</p>}
            {state.value.results.length === 0 ? (
              <p className="muted">No passages found for “{state.query}”.</p>
            ) : (
              <ol className="results" aria-label="Search results">
                {state.value.results.map((r) => (
                  <ResultItem key={r.chunkId} result={r} kind={kinds.get(r.materialId) ?? 'pdf'} />
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ResultItem({ result: r, kind }: { result: SearchResult; kind: 'pdf' | 'pptx' }) {
  const [expanded, setExpanded] = useState(false)
  const where = [r.chapter, r.section].filter(Boolean).join(' › ')
  const matchPages = formatPages(r.matchStart, r.matchEnd, kind)
  const passagePages = formatPages(r.pageStart, r.pageEnd, kind)
  const { before, focus, after } = r.context
  return (
    <li className="result" data-testid="search-result">
      <p className="result-source">
        <strong>{r.fileName}</strong>
        {where && <span> · {where}</span>}
        <span className="pages" data-testid="result-pages">
          {' '}
          · {matchPages}
        </span>
        {passagePages !== matchPages && (
          <span className="pages passage-pages" data-testid="result-passage-pages">
            {' '}
            (passage {passagePages})
          </span>
        )}
      </p>
      {r.focusKind === 'none' && <p className="muted small">Related by meaning; it shares no words with your question.</p>}
      <p className="snippet" data-testid="result-snippet">
        {before && (expanded ? <Highlighted text={before + ' '} /> : '… ')}
        <span className="focus" data-testid="result-focus">
          <Highlighted text={focus} />
        </span>
        {after && (expanded ? <Highlighted text={' ' + after} /> : ' …')}
      </p>
      {(before || after) && (
        <button type="button" className="link small" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? 'Show less' : 'Show the whole passage'}
        </button>
      )}
    </li>
  )
}

function Highlighted({ text }: { text: string }) {
  const parts = text.split(new RegExp(`(${MATCH_START}[^${MATCH_END}]*${MATCH_END})`, 'u'))
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith(MATCH_START) ? <mark key={i}>{part.slice(1, -1)}</mark> : <span key={i}>{part}</span>
      )}
    </>
  )
}
