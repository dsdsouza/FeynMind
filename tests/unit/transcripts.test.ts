import { describe, expect, it } from 'vitest'
import { chunkSection, sectionPageTexts } from '../../src/main/ingestion/chunker'
import { IngestionRepo } from '../../src/main/ingestion/repo'
import { transcribedLines } from '../../src/main/ingestion/transcripts'
import type { TextLine } from '../../src/main/ingestion/types'
import { openDatabase, SessionStore } from '../../src/main/storage'

const line = (text: string, y: number, size = 10): TextLine => ({ text, x: 72, y, size, bold: false })

const original: TextLine[] = [
  line('Running head', 30, 8),
  line('The product AB is defined when', 100),
  line('A B = [ a11 b11 + a12 b21 ... ]', 115),
  line('1.2 Next Section', 300, 14),
  line('Text of the next section here.', 320)
]

describe('transcribedLines', () => {
  it('places each block at its starting line and records the extracted text it replaces', () => {
    const lines = transcribedLines(original, [
      { fromLine: 1, text: 'The product $AB$ is defined when' },
      { fromLine: 2, text: '$$AB = \\begin{bmatrix} a_{11}b_{11} + a_{12}b_{21} \\end{bmatrix}$$' },
      { fromLine: 3, text: '## 1.2 Next Section' },
      { fromLine: 4, text: 'Text of the next section here.' }
    ])
    expect(lines.map((l) => l.y)).toEqual([100, 115, 300, 320])
    expect(lines[1]?.original).toBe('A B = [ a11 b11 + a12 b21 ... ]')
    expect(lines[0]?.original).toBe('The product AB is defined when')
  })

  it('handles a page with no extracted lines', () => {
    const lines = transcribedLines([], [{ fromLine: 0, text: '[Figure: a parabola opening upward]' }])
    expect(lines).toEqual([{ text: '[Figure: a parabola opening upward]', x: 0, y: 0, size: 10, bold: false, original: '' }])
  })
})

describe('chunking transcribed pages', () => {
  const page = {
    index: 5,
    height: 792,
    lines: transcribedLines(original, [
      { fromLine: 1, text: 'The product $AB$ is defined when' },
      { fromLine: 2, text: '$$AB = \\begin{bmatrix} a_{11} \\end{bmatrix}$$' },
      { fromLine: 3, text: '1.2 Next Section' },
      { fromLine: 4, text: 'Text of the next section here.' }
    ])
  }
  const start = { chapter: 'Ch 1', section: '1.1 Matrices', startPage: 5, startY: 0 }
  const next = { chapter: 'Ch 1', section: '1.2 Next Section', startPage: 5, startY: 300 }

  it('uses the transcription and keeps the original words for search, cut at the section boundary', () => {
    const chunks = chunkSection([page], start, next, 10)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.text).toContain('a_{11}')
    expect(chunks[0]?.text).not.toContain('Next Section')
    expect(chunks[0]?.originalText).toContain('a11 b11')
    expect(chunks[0]?.originalText).not.toContain('Text of the next section')
  })

  it('gives the section text page by page for extraction, with LaTeX intact', () => {
    const texts = sectionPageTexts([page], start, next, 10, true)
    expect(texts).toEqual([{ index: 5, text: 'The product $AB$ is defined when\n$$AB = \\begin{bmatrix} a_{11} \\end{bmatrix}$$' }])
  })

  it('leaves untranscribed chunks without original text', () => {
    const chunks = chunkSection([{ index: 5, height: 792, lines: original }], start, next, 10)
    expect(chunks[0]?.originalText).toBeNull()
  })
})

describe('re-chunking with transcripts in the database', () => {
  it('finds a passage by the transcription and by the original words', () => {
    const db = openDatabase(':memory:')
    const session = new SessionStore(db).current()
    const repo = new IngestionRepo(db)
    const materialId = repo.insertMaterial({ sessionId: session.id, sha256: 'abc', originalName: 'book.pdf', storedName: 'abc.pdf', kind: 'pdf', byteSize: 1 })
    repo.startMaterial(materialId, 1, 'outline')
    repo.insertPage({
      sessionId: session.id, materialId, pageIndex: 1, pageLabel: '7', status: 'done', method: 'text',
      lines: [line('Garbled eigen value λ1 = 2', 100)], height: 792, scanned: false, mathHeavy: true, figureHeavy: false, ocrConfidence: null, error: null
    })
    repo.insertSectionWithChunks({ sessionId: session.id, materialId }, 0, { chapter: 'Ch', section: 'S', startPage: 1, startY: 0 }, 'outline', [
      { text: 'Garbled eigen value λ1 = 2', pageStart: 1, pageEnd: 1, originalText: null }
    ])
    const sectionId = repo.sessionSections(session.id)[0]?.id ?? 0
    db.prepare(`INSERT INTO page_transcripts (session_id, material_id, page_index, blocks, text, cache_key) VALUES (?, ?, 1, ?, ?, 'k')`).run(
      session.id, materialId, JSON.stringify([{ fromLine: 0, text: 'The eigenvalue $\\lambda_1 = 2$ is positive.' }]), 'x'
    )

    const bounds = repo.sectionBounds(sectionId)
    expect(bounds?.lastPage).toBe(1)
    const pages = repo.loadPages(materialId, 1, 1, true)
    repo.replaceSectionChunks(sectionId, chunkSection(pages, { chapter: 'Ch', section: 'S', startPage: 1, startY: 0 }, null, 10))

    expect(repo.keywordSearch(session.id, '"positive"', 5)).toHaveLength(1)
    expect(repo.keywordSearch(session.id, '"garbled"', 5)).toHaveLength(1)
    const [id] = repo.keywordSearch(session.id, '"positive"', 5)
    expect(repo.chunkTexts([id ?? 0]).get(id ?? 0)?.text).toContain('\\lambda_1')
    // Extracted pages without transcripts are unchanged.
    expect(repo.loadPages(materialId, 1, 1)[0]?.lines[0]?.text).toBe('Garbled eigen value λ1 = 2')
  })
})
