import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzePage } from '../../src/main/ingestion/pageAnalysis'
import { openPptx } from '../../src/main/ingestion/pptx'
import { fixture } from './helpers'

describe('PowerPoint reader', () => {
  it('reads each slide as a page with its title, text and speaker notes, in order', async () => {
    const deck = await openPptx(fixture('vectors-dot-product.pptx'))
    expect(deck.pageCount).toBe(4)
    expect(await deck.pageLabels()).toBeNull()

    const slide2 = await deck.readPage(2)
    expect(slide2.lines.map((l) => l.text)).toEqual([
      'Computing the dot product',
      'Multiply matching components, then add the products.',
      'For v = (1, 2) and w = (3, 4): v · w = 1·3 + 2·4 = 11.',
      'Speaker notes:',
      'Students often forget to add the products at the end. Stress that the result is a scalar, not a vector.'
    ])
    expect(slide2.lines[0]).toMatchObject({ bold: true })
    expect(slide2.lines[0]?.size).toBeGreaterThan(slide2.lines[1]?.size ?? 0)
    // Lines run down the page in order.
    const ys = slide2.lines.map((l) => l.y)
    expect([...ys].sort((a, b) => a - b)).toEqual(ys)
  })

  it('builds the outline from the deck title and slide titles', async () => {
    const deck = await openPptx(fixture('vectors-dot-product.pptx'))
    expect(await deck.outline()).toEqual([
      { title: 'Vectors and the Dot Product', level: 1, page: 1, y: 0 },
      { title: 'Vectors and the Dot Product', level: 2, page: 1, y: 0 },
      { title: 'Computing the dot product', level: 2, page: 2, y: 0 },
      { title: 'The angle between two vectors', level: 2, page: 3, y: 0 },
      { title: 'Practice', level: 2, page: 4, y: 0 }
    ])
  })

  it('flags a slide that is mostly a picture and cannot render slides', async () => {
    const deck = await openPptx(fixture('vectors-dot-product.pptx'))
    const slide3 = await deck.readPage(3)
    expect(slide3.stats.imageCoverage).toBeGreaterThan(0.3)
    expect(analyzePage(slide3).figureHeavy).toBe(true)
    expect(analyzePage(await deck.readPage(2)).figureHeavy).toBe(false)
    expect(await deck.renderPage(3, 150)).toBeNull()
  })

  it('rejects a file that is not a .pptx deck', async () => {
    const path = join(tmpdir(), `feynmind-not-a-deck-${process.pid}.pptx`)
    writeFileSync(path, 'plain text, not a zip archive')
    await expect(openPptx(path)).rejects.toThrow(/not a readable PowerPoint/)
  })
})
