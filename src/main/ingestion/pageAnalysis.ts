import type { PageContent } from './types'

export interface PageFlags {
  /** Too little extractable text over a large image: the page must be read with text recognition. */
  scanned: boolean
  /** Displayed math (fractions, matrices, many symbols) that plain text extraction garbles. */
  mathHeavy: boolean
  /** Much of the page is a figure, chart or diagram. */
  figureHeavy: boolean
}

// Thresholds were set by inspecting the fixtures and a full scanned linear algebra textbook.
// They are deliberately simple; milestone 3 decides what to do with flagged pages.

/** Fewer non-blank characters than this means the page has no usable text layer. */
const SCANNED_MAX_CHARS = 25
/** ...when at least this share of the page is covered by images. */
const SCANNED_MIN_IMAGE_COVERAGE = 0.5
/** An image covering at least this share of the page is the page itself (a scan), not a figure. */
const FULL_PAGE_IMAGE = 0.9

const MATH_FONT_SHARE = 0.1
const MATH_SYMBOL_SHARE = 0.04
const MATH_LAYOUT_MIN_LINES = 6
const MATH_LAYOUT_SHARE = 0.2

const FIGURE_IMAGE_COVERAGE = 0.25
const FIGURE_PATH_OPS = 150
/** A blank vertical stretch between text lines this tall (share of page height) is usually a figure. */
const FIGURE_TEXT_GAP = 0.25

export function analyzePage(page: PageContent): PageFlags {
  const s = page.stats
  const scanned = s.charCount < SCANNED_MAX_CHARS && s.imageCoverage >= SCANNED_MIN_IMAGE_COVERAGE
  if (scanned) {
    // Recognized text is analyzed by its own confidence instead; layout signals are not available.
    return { scanned, mathHeavy: false, figureHeavy: false }
  }
  const chars = Math.max(1, s.charCount)
  const mathHeavy =
    s.mathFontChars / chars >= MATH_FONT_SHARE ||
    s.mathSymbolChars / chars >= MATH_SYMBOL_SHARE ||
    (s.mathLayoutLines >= MATH_LAYOUT_MIN_LINES && s.mathLayoutLines / Math.max(1, s.lineCount) >= MATH_LAYOUT_SHARE)

  const figureImage = s.imageCoverage >= FIGURE_IMAGE_COVERAGE && s.imageCoverage < FULL_PAGE_IMAGE
  const figureHeavy =
    figureImage || s.pathOps >= FIGURE_PATH_OPS || (s.charCount > 0 && largestTextGap(page) >= FIGURE_TEXT_GAP)

  return { scanned, mathHeavy, figureHeavy }
}

/**
 * The tallest blank vertical stretch between consecutive text lines, as a share of the page
 * height. The top and bottom margins (running heads, page numbers) are ignored.
 */
export function largestTextGap(page: PageContent): number {
  if (page.height <= 0) return 0
  const top = page.height * 0.08
  const bottom = page.height * 0.92
  const spans = page.lines
    .map((line) => ({ top: line.y - line.size, bottom: line.y }))
    .filter((span) => span.bottom >= top && span.top <= bottom)
    .sort((a, b) => a.top - b.top)
  if (spans.length < 2) return 0
  let largest = 0
  let reached = spans[0]?.bottom ?? 0
  for (const span of spans.slice(1)) {
    largest = Math.max(largest, span.top - reached)
    reached = Math.max(reached, span.bottom)
  }
  return largest / page.height
}
