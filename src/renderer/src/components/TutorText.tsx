import Markdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import { resolveCitation, type SourceRef } from '../../../shared/citations'
import { formatPages } from '../lib'
import { CITE_HREF, linkCitations, normalizeMath } from '../../../shared/markdown'

/** A page a citation points to, for the page preview. */
export interface CitedPage {
  materialId: number
  page: number
  label: string | null
  fileName: string
}

/**
 * Tutor text, questions and passages: Markdown with LaTeX math (KaTeX), raw HTML shown as text,
 * and citations that open the cited page. A citation naming a page that was not among the
 * passages is shown, marked, without a link.
 */
export function TutorText({ text, sources, onOpenPage, inline = false }: { text: string; sources: SourceRef[]; onOpenPage: (page: CitedPage) => void; inline?: boolean }) {
  const components: Components = {
    a: ({ href, children }) => {
      if (href?.startsWith(CITE_HREF)) {
        const cite = decodeURIComponent(href.slice(CITE_HREF.length))
        const found = resolveCitation(sources, cite)
        if (!found) {
          return (
            <span className="cite cite-bad" title="This page was not among the passages the tutor was given.">
              [{cite}]
            </span>
          )
        }
        const { source, page } = found
        return (
          <button
            type="button"
            className="cite"
            title={`${source.fileName}${source.section ? `, ${source.section}` : ''}, ${formatPages(page, page)}`}
            onClick={() => onOpenPage({ materialId: source.materialId, page: page.index, label: page.label, fileName: source.fileName })}
          >
            {formatPages(page, page)}
          </button>
        )
      }
      // Links from the model are shown as text: the tutor never sends the learner elsewhere.
      return <span>{children}</span>
    },
    ...(inline ? { p: ({ children }) => <span>{children}</span> } : {})
  }
  return (
    <div className={inline ? 'tutor-text inline' : 'tutor-text'}>
      <Markdown remarkPlugins={[remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: 'ignore' }]]} components={components}>
        {linkCitations(normalizeMath(text))}
      </Markdown>
    </div>
  )
}
