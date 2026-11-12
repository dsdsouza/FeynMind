import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { packageDir } from './packagePaths'
import type { DocumentSource, OutlineEntry, PageContent, PageStats, TextLine } from './types'

type Pdfjs = typeof import('pdfjs-dist')

const require = createRequire(import.meta.url)
let pdfjsModule: Promise<Pdfjs> | null = null

/** Loads PDF.js's Node build once. It is an ES module, so it is imported rather than required. */
function loadPdfjs(): Promise<Pdfjs> {
  pdfjsModule ??= import(/* @vite-ignore */ pathToFileURL(join(packageDir('pdfjs-dist'), 'legacy', 'build', 'pdf.mjs')).href) as Promise<Pdfjs>
  return pdfjsModule
}

/** Font names that mark math typesetting (TeX, STIX, Cambria Math, Symbol and similar). */
const MATH_FONT = /^(?:[A-Z]{6}\+)?(?:CM(?:MI|SY|EX|BSY|MIB)|MSAM|MSBM|EUFM|EUSM|RSFS|STIX|XITS|Asana|CambriaMath|Cambria-Math|LatinModernMath|MathJax|MT(?:Extra|Symbol|MI|SY)|Symbol|Mathematica|MathematicalPi|Euclid|Lucida(?:New)?Math|TeXGyre\w*Math|Math)/i
/** Greek letters, math operators, arrows, letterlike symbols and a few ASCII operators. */
const MATH_SYMBOL = /[Α-ω←-⇿∀-⋿⨀-⫿⟀-⟯℀-⅏±×÷′″=+<>^−√∑∫]/gu

const BOLD_FONT = /bold|black|heavy|semibold|demi/i

/** PDF.js reads its data folders from paths written with forward slashes and a trailing slash. */
function folderUrl(base: string, folder: string): string {
  return `${join(base, folder).replaceAll('\\', '/')}/`
}

/** Opens a PDF for reading page by page. The file is read in ranges, not loaded whole. */
export async function openPdf(path: string): Promise<DocumentSource> {
  const pdfjs = await loadPdfjs()
  const dataDir = packageDir('pdfjs-dist')
  const task = pdfjs.getDocument({
    url: path,
    // Font, character map and image decoder data that ships with PDF.js, read from disk.
    standardFontDataUrl: folderUrl(dataDir, 'standard_fonts'),
    cMapUrl: folderUrl(dataDir, 'cmaps'),
    cMapPacked: true,
    wasmUrl: folderUrl(dataDir, 'wasm'),
    disableFontFace: true,
    verbosity: 0
  })
  let doc: PDFDocumentProxy
  try {
    doc = await task.promise
  } catch (error) {
    await task.destroy()
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new Error('This PDF is password-protected. Remove the password and add it again.', { cause: error })
    }
    throw error
  }
  return new PdfSource(pdfjs, doc, () => task.destroy())
}

/** PDF.js keeps decoded images and fonts for the whole document; clear them this often (in pages read). */
const CLEANUP_EVERY_PAGES = 50

class PdfSource implements DocumentSource {
  readonly pageCount: number
  private pagesSinceCleanup = 0

  constructor(
    private readonly pdfjs: Pdfjs,
    private readonly doc: PDFDocumentProxy,
    private readonly destroy: () => Promise<void>
  ) {
    this.pageCount = doc.numPages
  }

  async pageLabels(): Promise<(string | null)[] | null> {
    const labels = await this.doc.getPageLabels()
    if (!labels || labels.length !== this.pageCount) return null
    // Labels that merely repeat the page position ("1", "2", ...) carry no information.
    if (labels.every((label, i) => label === String(i + 1))) return null
    return labels.map((label) => (label.trim() === '' ? null : label.trim()))
  }

  async outline(): Promise<OutlineEntry[]> {
    const outline = await this.doc.getOutline()
    if (!outline) return []
    const entries: OutlineEntry[] = []
    const visit = async (items: typeof outline, level: number): Promise<void> => {
      for (const item of items) {
        const target = await this.resolveDestination(item.dest)
        const title = item.title.replace(/\s+/g, ' ').trim()
        if (target && title) entries.push({ title, level, ...target })
        // Deeper levels (subsections) are kept inside their section.
        if (level < 2) await visit(item.items, level + 1)
      }
    }
    await visit(outline, 1)
    return entries
  }

  async readPage(pageIndex: number): Promise<PageContent> {
    if (++this.pagesSinceCleanup >= CLEANUP_EVERY_PAGES) {
      this.pagesSinceCleanup = 0
      await this.doc.cleanup()
    }
    const page = await this.doc.getPage(pageIndex)
    try {
      const { width, height } = page.getViewport({ scale: 1 })
      // The operator list loads the page's fonts (needed for their real names) and shows images and paths.
      const ops = await page.getOperatorList()
      const drawing = this.measureDrawing(ops.fnArray, ops.argsArray, width * height)
      const content = await page.getTextContent()
      const items = content.items.filter((item): item is TextItem => 'str' in item)
      const fontNames = this.fontNames(page, items)
      const lines = buildLines(items, height, fontNames)
      const stats: PageStats = {
        ...measureText(items, fontNames),
        ...drawing,
        mathLayoutLines: countMathLayoutLines(items, height),
        lineCount: lines.length
      }
      return { width, height, lines, stats }
    } finally {
      page.cleanup()
    }
  }

  async renderPage(pageIndex: number, dpi: number): Promise<Buffer> {
    const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas')
    const page = await this.doc.getPage(pageIndex)
    try {
      const base = page.getViewport({ scale: 1 })
      // Keep very large pages (posters, maps) to a size text recognition can handle.
      const scale = Math.min(dpi / 72, 6000 / Math.max(base.width, base.height))
      const viewport = page.getViewport({ scale })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const context = canvas.getContext('2d')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      // @napi-rs/canvas implements the subset of the browser canvas API that PDF.js uses.
      type RenderParameters = Parameters<PDFPageProxy['render']>[0]
      await page.render({
        canvas: canvas as unknown as RenderParameters['canvas'],
        canvasContext: context as unknown as RenderParameters['canvasContext'],
        viewport
      }).promise
      return await canvas.encode('png')
    } finally {
      page.cleanup()
    }
  }

  async close(): Promise<void> {
    await this.destroy()
  }

  private async resolveDestination(dest: unknown): Promise<{ page: number; y: number } | null> {
    try {
      const explicit = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest
      if (!Array.isArray(explicit) || explicit.length === 0) return null
      const ref: unknown = explicit[0]
      const pageIndex =
        typeof ref === 'number' ? ref : await this.doc.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0])
      const page = await this.doc.getPage(pageIndex + 1)
      const height = page.getViewport({ scale: 1 }).height
      // /XYZ left top zoom and /FitH top and /FitBH top give the heading's height on the page.
      const kind = (explicit[1] as { name?: string } | undefined)?.name
      const top = kind === 'XYZ' ? explicit[3] : kind === 'FitH' || kind === 'FitBH' ? explicit[2] : null
      const y = typeof top === 'number' ? Math.max(0, Math.min(height, height - top)) : 0
      return { page: pageIndex + 1, y }
    } catch {
      return null
    }
  }

  private fontNames(page: PDFPageProxy, items: TextItem[]): Map<string, string> {
    const names = new Map<string, string>()
    for (const item of items) {
      if (names.has(item.fontName)) continue
      let name = ''
      try {
        const font = page.commonObjs.get(item.fontName) as { name?: string } | undefined
        name = font?.name ?? ''
      } catch {
        // The font object is not available; treat it as an ordinary text font.
      }
      names.set(item.fontName, name)
    }
    return names
  }

  /** Image coverage and path counts from the page's drawing operations. */
  private measureDrawing(fnArray: number[], argsArray: unknown[], pageArea: number): Pick<PageStats, 'imageCoverage' | 'pathOps'> {
    const OPS = this.pdfjs.OPS
    let matrix: Matrix = [1, 0, 0, 1, 0, 0]
    const stack: Matrix[] = []
    let imageArea = 0
    let pathOps = 0
    fnArray.forEach((fn, i) => {
      const args = argsArray[i] as unknown[] | null
      switch (fn) {
        case OPS.save:
        case OPS.paintFormXObjectBegin:
          stack.push(matrix)
          if (fn === OPS.paintFormXObjectBegin && Array.isArray(args?.[0])) matrix = multiply(matrix, args[0] as Matrix)
          break
        case OPS.restore:
        case OPS.paintFormXObjectEnd:
          matrix = stack.pop() ?? matrix
          break
        case OPS.transform:
          if (args) matrix = multiply(matrix, args as Matrix)
          break
        case OPS.paintImageXObject:
        case OPS.paintInlineImageXObject:
        case OPS.paintImageMaskXObject:
        case OPS.paintImageXObjectRepeat:
          // Images are drawn into the unit square, so the matrix's determinant is the image's area.
          imageArea += Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2])
          break
        case OPS.constructPath:
          pathOps++
          break
      }
    })
    return { imageCoverage: pageArea > 0 ? Math.min(1, imageArea / pageArea) : 0, pathOps }
  }
}

type Matrix = [number, number, number, number, number, number]

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    n[0] * m[0] + n[1] * m[2],
    n[0] * m[1] + n[1] * m[3],
    n[2] * m[0] + n[3] * m[2],
    n[2] * m[1] + n[3] * m[3],
    n[4] * m[0] + n[5] * m[2] + m[4],
    n[4] * m[1] + n[5] * m[3] + m[5]
  ]
}

function fontSize(item: TextItem): number {
  const [, , c, d] = item.transform as number[]
  return Math.hypot(c ?? 0, d ?? 0) || item.height || 0
}

function measureText(items: TextItem[], fontNames: Map<string, string>): Pick<PageStats, 'charCount' | 'mathFontChars' | 'mathSymbolChars'> {
  let charCount = 0
  let mathFontChars = 0
  let mathSymbolChars = 0
  for (const item of items) {
    const chars = item.str.replace(/\s/g, '').length
    charCount += chars
    if (MATH_FONT.test(fontNames.get(item.fontName) ?? '')) mathFontChars += chars
    mathSymbolChars += item.str.match(MATH_SYMBOL)?.length ?? 0
  }
  return { charCount, mathFontChars, mathSymbolChars }
}

/**
 * Groups text pieces into lines in content order. A piece joins the current line when its
 * baseline is within half a font size (so superscripts and subscripts stay on their line).
 */
export function buildLines(items: TextItem[], pageHeight: number, fontNames: Map<string, string>): TextLine[] {
  interface Piece {
    str: string
    x: number
    y: number
    right: number
    size: number
    bold: boolean
  }
  const groups: Piece[][] = []
  let current: Piece[] = []
  let lineY = Number.NaN
  let lineSize = 0
  for (const item of items) {
    const [, , , , e, f] = item.transform as number[]
    const size = fontSize(item)
    const piece: Piece = {
      str: item.str,
      x: e ?? 0,
      y: pageHeight - (f ?? 0),
      right: (e ?? 0) + item.width,
      size,
      bold: BOLD_FONT.test(fontNames.get(item.fontName) ?? '')
    }
    if (item.str.trim() === '') {
      if (item.hasEOL && current.length > 0) {
        groups.push(current)
        current = []
        lineY = Number.NaN
      }
      continue
    }
    const tolerance = Math.max(lineSize, size, 1) * 0.5
    if (current.length > 0 && Math.abs(piece.y - lineY) > tolerance) {
      groups.push(current)
      current = []
    }
    if (current.length === 0) {
      lineY = piece.y
      lineSize = size
    } else if (size > lineSize) {
      lineSize = size
    }
    current.push(piece)
    if (item.hasEOL) {
      groups.push(current)
      current = []
      lineY = Number.NaN
    }
  }
  if (current.length > 0) groups.push(current)

  const lines: TextLine[] = []
  for (const group of groups) {
    const pieces = [...group].sort((a, b) => a.x - b.x)
    let text = ''
    let prev: Piece | null = null
    for (const piece of pieces) {
      if (prev) {
        const gap = piece.x - prev.right
        const needsSpace = gap > Math.min(prev.size, piece.size) * 0.15 && !text.endsWith(' ') && !piece.str.startsWith(' ')
        if (needsSpace) text += ' '
      }
      text += piece.str
      prev = piece
    }
    text = text.replace(/\s+/g, ' ').trim()
    if (text === '') continue
    // The line's size and position come from its dominant (most characters) piece.
    const dominant = pieces.reduce((a, b) => (b.str.length > a.str.length ? b : a))
    const boldChars = pieces.filter((p) => p.bold).reduce((n, p) => n + p.str.length, 0)
    lines.push({
      text,
      x: round(pieces[0]?.x ?? 0),
      y: round(dominant.y),
      size: round(dominant.size),
      bold: boldChars * 2 > text.length
    })
  }
  return lines
}

/**
 * Counts lines laid out like displayed math: several pieces at clearly different heights
 * (fractions, stacked limits) or rows made mostly of one- or two-character pieces with wide gaps
 * (matrices, aligned equations). Plain text extraction loses this layout.
 */
function countMathLayoutLines(items: TextItem[], pageHeight: number): number {
  const rows = new Map<number, { ys: Set<number>; pieces: number; tiny: number; chars: number }>()
  for (const item of items) {
    const str = item.str.trim()
    if (str === '') continue
    const [, , , , , f] = item.transform as number[]
    const size = fontSize(item)
    const y = pageHeight - (f ?? 0)
    // Bucket pieces into bands about two font sizes tall.
    const band = Math.round(y / Math.max(size * 2, 8))
    const row = rows.get(band) ?? { ys: new Set<number>(), pieces: 0, tiny: 0, chars: 0 }
    row.ys.add(Math.round(y / Math.max(size * 0.25, 1)))
    row.pieces++
    row.chars += str.length
    if (str.length <= 2) row.tiny++
    rows.set(band, row)
  }
  let count = 0
  for (const row of rows.values()) {
    const stacked = row.ys.size >= 3 && row.pieces >= 4
    const gridLike = row.pieces >= 5 && row.tiny / row.pieces >= 0.6
    if ((stacked || gridLike) && row.chars < 120) count++
  }
  return count
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}
