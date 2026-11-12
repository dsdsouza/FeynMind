// Internal types of the ingestion module.

/** One line of text on a page. Positions are in PDF units (1/72 inch), measured from the page's top-left. */
export interface TextLine {
  text: string
  x: number
  /** Baseline, measured down from the top of the page. */
  y: number
  /** Font size of the line's dominant text. */
  size: number
  bold: boolean
}

/** Raw measurements of a page, used to decide whether it is scanned, math-heavy or figure-heavy. */
export interface PageStats {
  /** Non-whitespace characters of extractable text. */
  charCount: number
  /** Share of the page covered by images, 0..1. */
  imageCoverage: number
  /** Number of vector path drawing operations (graphs and diagrams are usually drawn this way). */
  pathOps: number
  /** Characters set in fonts whose names mark them as math fonts. */
  mathFontChars: number
  /** Characters that are math symbols or Greek letters. */
  mathSymbolChars: number
  /** Lines whose text pieces sit at different heights or are mostly one-character pieces (fractions, matrices, scripts). */
  mathLayoutLines: number
  lineCount: number
}

export interface PageContent {
  width: number
  height: number
  lines: TextLine[]
  stats: PageStats
}

/** A chapter or section start taken from the document's own outline (PDF bookmarks or slide titles). */
export interface OutlineEntry {
  title: string
  /** 1 = chapter, 2 = section. */
  level: number
  /** 1-based page index. */
  page: number
  /** Where the heading starts, measured down from the top of the page. 0 when unknown. */
  y: number
}

/** A readable document: a PDF, or a slide deck where each slide is a page. */
export interface DocumentSource {
  readonly pageCount: number
  /** The printed page number of each page, or null when the file does not say. */
  pageLabels(): Promise<(string | null)[] | null>
  outline(): Promise<OutlineEntry[]>
  readPage(pageIndex: number): Promise<PageContent>
  /** Renders a page to PNG, or returns null when this kind of document cannot be rendered. */
  renderPage(pageIndex: number, dpi: number): Promise<Buffer | null>
  close(): Promise<void>
}
