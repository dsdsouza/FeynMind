import { describe, expect, it } from 'vitest'
import { createTesseractOcr } from '../../src/main/ingestion/ocr'
import { analyzePage, largestTextGap } from '../../src/main/ingestion/pageAnalysis'
import { openPdf } from '../../src/main/ingestion/pdf'
import type { PageContent } from '../../src/main/ingestion/types'
import { fixture } from './helpers'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47])

describe('PDF reader', () => {
  it('reads text per page with positions, printed page labels and the outline', async () => {
    const doc = await openPdf(fixture('openstax-precalculus-text.pdf'))
    try {
      expect(doc.pageCount).toBe(6)
      expect(await doc.pageLabels()).toEqual(['1', '2', '3', '21', '22', '23'])
      expect(await doc.outline()).toEqual([
        { title: 'Chapter 1. Functions', level: 1, page: 1, y: 0 },
        { title: '1.1. Functions and Function Notation', level: 2, page: 2, y: 185 },
        { title: '1.2. Domain and Range', level: 2, page: 5, y: 138 }
      ])

      const page2 = await doc.readPage(2)
      const text = page2.lines.map((l) => l.text).join('\n')
      expect(text).toContain('A relation is a set of ordered pairs.')
      expect(text).toContain('Download for free at https://openstax.org/details/books/precalculus.')
      // The section heading sits just below the outline's position for section 1.1.
      const heading = page2.lines.find((l) => l.text.startsWith('1.1'))
      expect(heading?.y).toBeGreaterThan(185)
      expect(heading?.size).toBeGreaterThan(12)
    } finally {
      await doc.close()
    }
  })

  it('returns no labels for a PDF without them', async () => {
    const doc = await openPdf(fixture('openstax-precalculus-scanned.pdf'))
    try {
      expect(await doc.pageLabels()).toBeNull()
      expect(await doc.outline()).toEqual([])
    } finally {
      await doc.close()
    }
  })

  it('renders a page to PNG', async () => {
    const doc = await openPdf(fixture('openstax-precalculus-math-figures.pdf'))
    try {
      const png = await doc.renderPage(1, 72)
      expect(png?.subarray(0, 4)).toEqual(PNG_SIGNATURE)
      // 72 DPI: one pixel per PDF unit, so a US Letter page is 612 pixels wide.
      expect(png?.readUInt32BE(16)).toBe(612)
    } finally {
      await doc.close()
    }
  })

  it('rejects a file that is not a PDF', async () => {
    await expect(openPdf(fixture('README.md'))).rejects.toThrow()
  })
})

describe('page analysis', () => {
  async function flagsOf(file: string): Promise<ReturnType<typeof analyzePage>[]> {
    const doc = await openPdf(fixture(file))
    try {
      const flags = []
      for (let i = 1; i <= doc.pageCount; i++) flags.push(analyzePage(await doc.readPage(i)))
      return flags
    } finally {
      await doc.close()
    }
  }

  it('marks image-only pages as scanned', async () => {
    expect(await flagsOf('openstax-precalculus-scanned.pdf')).toEqual([
      { scanned: true, mathHeavy: false, figureHeavy: false },
      { scanned: true, mathHeavy: false, figureHeavy: false }
    ])
  })

  it('flags the matrix page as math-heavy and the graphs page as figure-heavy', async () => {
    const [matrices, graphs] = await flagsOf('openstax-precalculus-math-figures.pdf')
    expect(matrices).toMatchObject({ scanned: false, mathHeavy: true, figureHeavy: false })
    expect(graphs).toMatchObject({ scanned: false, figureHeavy: true })
  })

  it('leaves ordinary text pages unflagged', async () => {
    const flags = await flagsOf('openstax-precalculus-text.pdf')
    expect(flags.every((f) => !f.scanned)).toBe(true)
    // Pages 2 and 5 are prose with small diagrams.
    expect(flags[1]).toEqual({ scanned: false, mathHeavy: false, figureHeavy: false })
    expect(flags[4]).toEqual({ scanned: false, mathHeavy: false, figureHeavy: false })
  })

  it('does not treat a full-page scan image under a text layer as a figure', () => {
    const page: PageContent = {
      width: 600,
      height: 800,
      lines: Array.from({ length: 40 }, (_, i) => ({ text: 'plain words on a line', x: 50, y: 70 + i * 17, size: 10, bold: false })),
      stats: { charCount: 1500, imageCoverage: 1, pathOps: 0, mathFontChars: 0, mathSymbolChars: 0, mathLayoutLines: 0, lineCount: 40 }
    }
    expect(analyzePage(page)).toEqual({ scanned: false, mathHeavy: false, figureHeavy: false })
  })

  it('measures the tallest blank stretch between text lines', () => {
    const line = (y: number) => ({ text: 'x', x: 0, y, size: 10, bold: false })
    const page = { width: 600, height: 1000, lines: [line(200), line(220), line(530), line(550)] } as PageContent
    expect(largestTextGap(page)).toBeCloseTo(0.3)
  })
})

describe('text recognition', () => {
  it('reads a scanned page with positions in PDF units', async () => {
    const doc = await openPdf(fixture('openstax-precalculus-scanned.pdf'))
    const ocr = createTesseractOcr()
    try {
      const dpi = 200
      const png = await doc.renderPage(1, dpi)
      if (!png) throw new Error('render failed')
      const result = await ocr.recognize(png, dpi / 72)
      const text = result.lines.map((l) => l.text).join('\n')
      expect(text).toContain('A relation is a set of ordered pairs')
      expect(text.toLowerCase()).toContain('download for free')
      expect(result.confidence).toBeGreaterThan(70)
      // Same page as the text fixture's page 2: the section heading is near the same height.
      const heading = result.lines.find((l) => /^1\.1\b/.test(l.text))
      expect(heading?.y).toBeGreaterThan(190)
      expect(heading?.y).toBeLessThan(220)
    } finally {
      await ocr.close()
      await doc.close()
    }
  }, 60_000)
})
