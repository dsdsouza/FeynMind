import { describe, expect, it } from 'vitest'
import { chunkSection, DEFAULT_CHUNK_OPTIONS } from '../../src/main/ingestion/chunker'
import { openPdf } from '../../src/main/ingestion/pdf'
import {
  bodyFontSize,
  contentLines,
  detectHeadings,
  headingStyleOf,
  inferPageLabels,
  isUsableOutline,
  sectionsFromOutline,
  splitLongSections,
  type StoredPage
} from '../../src/main/ingestion/structure'
import type { TextLine } from '../../src/main/ingestion/types'
import { fixture, must } from './helpers'

async function readAll(file: string): Promise<{ pages: StoredPage[]; outline: Awaited<ReturnType<Awaited<ReturnType<typeof openPdf>>['outline']>> }> {
  const doc = await openPdf(fixture(file))
  try {
    const pages: StoredPage[] = []
    for (let i = 1; i <= doc.pageCount; i++) {
      const content = await doc.readPage(i)
      pages.push({ index: i, height: content.height, lines: content.lines })
    }
    return { pages, outline: await doc.outline() }
  } finally {
    await doc.close()
  }
}

const line = (text: string, y: number, size = 10, bold = false): TextLine => ({ text, x: 50, y, size, bold })

describe('sections from the outline', () => {
  it('names chapters and sections and starts them where the outline points', () => {
    const starts = sectionsFromOutline([
      { title: 'Chapter 1. Functions', level: 1, page: 1, y: 0 },
      { title: '1.1. Functions and Function Notation', level: 2, page: 2, y: 185 },
      { title: '1.2. Domain and Range', level: 2, page: 5, y: 138 }
    ])
    expect(starts).toEqual([
      { chapter: 'Chapter 1. Functions', section: null, startPage: 1, startY: 0 },
      { chapter: 'Chapter 1. Functions', section: '1.1. Functions and Function Notation', startPage: 2, startY: 185 },
      { chapter: 'Chapter 1. Functions', section: '1.2. Domain and Range', startPage: 5, startY: 138 }
    ])
  })

  it('adds an untitled start for front matter and merges a chapter with a section at the same spot', () => {
    const starts = sectionsFromOutline([
      { title: 'Chapter 2', level: 1, page: 10, y: 50 },
      { title: '2.1 Vectors', level: 2, page: 10, y: 50 }
    ])
    expect(starts).toEqual([
      { chapter: null, section: null, startPage: 1, startY: 0 },
      { chapter: 'Chapter 2', section: '2.1 Vectors', startPage: 10, startY: 50 }
    ])
  })

  it('ignores an outline that points to only one place', () => {
    expect(isUsableOutline([{ title: 'Cover', level: 1, page: 1, y: 0 }])).toBe(false)
    expect(isUsableOutline([{ title: 'A', level: 1, page: 1, y: 0 }, { title: 'B', level: 1, page: 3, y: 0 }])).toBe(true)
  })
})

describe('chunking the text fixture by its outline', () => {
  it('keeps every chunk inside its section with the right page range', async () => {
    const { pages, outline } = await readAll('openstax-precalculus-text.pdf')
    const starts = sectionsFromOutline(outline)
    const body = bodyFontSize(pages)
    expect(body).toBe(10.5)

    const s11 = chunkSection(pages, must(starts[1]), must(starts[2]), body)
    const s12 = chunkSection(pages, must(starts[2]), null, body)

    // Section 1.1 spans pages 2-5 (it ends partway down page 5); 1.2 starts on page 5.
    expect(s11[0]?.text).toMatch(/^1\.1 FUnCTIOnS AnD FUnCTIOn nOTATIOn A jetliner changes altitude/)
    expect(s11.at(-1)?.pageEnd).toBe(5)
    expect(s11.map((c) => c.text).join(' ')).not.toContain('DOMAIn AnD RAnGe')
    expect(s12[0]?.pageStart).toBe(5)
    expect(s12[0]?.text).toMatch(/^1\. 2 DOMAIn AnD RAnGe If you’re in the mood for a scary movie/)
    expect(s12.map((c) => c.text).join(' ')).not.toContain('A jetliner')

    for (const chunk of [...s11, ...s12]) {
      expect(chunk.text.split(' ').length).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxWords + DEFAULT_CHUNK_OPTIONS.overlapWords)
      expect(chunk.pageEnd).toBeGreaterThanOrEqual(chunk.pageStart)
    }
    // Running heads ("2 CHAPTER 1 Functions") and the attribution footer are not part of the text.
    expect(s11.map((c) => c.text).join(' ')).not.toMatch(/CHAPTER 1 Functions|Download for free/)
  })

  it('finds the sections from headings when the outline is ignored', async () => {
    const { pages } = await readAll('openstax-precalculus-text.pdf')
    const style = headingStyleOf(pages)
    expect(style).toEqual({ bodySize: 10.5, numbered: true })
    const titles = detectHeadings(pages, must(style)).map((s) => [s.startPage, s.chapter, s.section])
    expect(titles).toEqual([
      [1, 'Functions', null],
      [2, 'Functions', '1.1 FUnCTIOnS AnD FUnCTIOn nOTATIOn'],
      [5, 'Functions', '1. 2 DOMAIn AnD RAnGe']
    ])
  })
})

describe('chunk packing', () => {
  const words = (n: number, from = 0): string =>
    Array.from({ length: n }, (_, i) => `w${from + i}${(i + 1) % 12 === 0 ? '.' : ''}`).join(' ')

  it('splits long text near the target size, overlaps chunks, and tracks pages', () => {
    const pages: StoredPage[] = [1, 2, 3].map((index) => ({
      index,
      height: 800,
      lines: Array.from({ length: 20 }, (_, i) => line(words(12, (index - 1) * 240 + i * 12), 100 + i * 12))
    }))
    const chunks = chunkSection(pages, { chapter: null, section: null, startPage: 1, startY: 0 }, null, 10)
    expect(chunks.length).toBe(3)
    expect(chunks[0]).toMatchObject({ pageStart: 1, pageEnd: 2 })
    expect(chunks[0]?.text.startsWith('w0 ')).toBe(true)
    // The second chunk repeats the end of the first.
    const firstEnd = chunks[0]?.text.split(' ').slice(-10).join(' ') ?? ''
    expect(chunks[1]?.text).toContain(firstEnd)
    expect(chunks.at(-1)?.pageEnd).toBe(3)
  })

  it('rejoins words hyphenated across lines', () => {
    const page: StoredPage = { index: 1, height: 800, lines: [line('we can deter-', 100), line('mine the domain.', 112)] }
    const [chunk] = chunkSection([page], { chapter: null, section: null, startPage: 1, startY: 0 }, null, 10)
    expect(chunk?.text).toBe('we can determine the domain.')
  })
})

describe('page labels from printed page numbers', () => {
  it('infers numbers from running heads when nearby pages agree', () => {
    // Printed page = position - 10, alternating between the start and end of the running head.
    const pages: StoredPage[] = Array.from({ length: 12 }, (_, i) => {
      const index = 20 + i
      const printed = index - 10
      const head = index % 2 === 0 ? `${printed} Chapter 1. Introduction to Vectors` : `1.2. Lengths and Dot Products ${printed}`
      return { index, height: 700, lines: [line(head, 42, 9), line('Body text with 3 numbers 17 inside.', 300)] }
    })
    // A chapter opener with no running head still gets its number from its neighbours.
    pages[5] = { index: 25, height: 700, lines: [line('Chapter 2', 200, 20)] }
    const labels = inferPageLabels(pages)
    expect(labels.get(20)).toBe('10')
    expect(labels.get(25)).toBe('15')
    expect(labels.get(31)).toBe('21')
  })

  it('gives no labels when there are no page numbers', () => {
    const pages: StoredPage[] = [1, 2, 3, 4, 5].map((index) => ({ index, height: 700, lines: [line('Text only', 300)] }))
    expect(inferPageLabels(pages).size).toBe(0)
  })
})

describe('helpers', () => {
  it('drops short running heads but keeps large headings in the margin', () => {
    const page: StoredPage = { index: 1, height: 800, lines: [line('2 CHAPTER 1 Functions', 40), line('Big Title', 50, 24), line('Body', 400)] }
    expect(contentLines(page, 10).map((l) => l.text)).toEqual(['Big Title', 'Body'])
  })

  it('adds breaks in long stretches without headings', () => {
    const starts = splitLongSections([{ chapter: 'C', section: null, startPage: 1, startY: 0 }], 45, 20)
    expect(starts.map((s) => s.startPage)).toEqual([1, 21, 41])
    expect(starts.every((s) => s.chapter === 'C')).toBe(true)
  })
})

describe('heading style', () => {
  it('uses every large heading when sections are not numbered', () => {
    const pages: StoredPage[] = [1, 2].map((index) => ({
      index,
      height: 800,
      lines: [line(`Topic ${index === 1 ? 'One' : 'Two'}`, 100, 14), ...Array.from({ length: 30 }, (_, i) => line('ordinary body text for the page', 130 + i * 14))]
    }))
    const style = headingStyleOf(pages)
    expect(style).toEqual({ bodySize: 10, numbered: false })
    expect(detectHeadings(pages, must(style)).map((s) => s.section)).toEqual(['Topic One', 'Topic Two'])
  })
})
