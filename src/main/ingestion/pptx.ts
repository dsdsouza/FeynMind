import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { strFromU8, unzipSync } from 'fflate'
import type { DocumentSource, OutlineEntry, PageContent, TextLine } from './types'

// Reads a PowerPoint (.pptx) deck. Each slide is one page: its title, its text (including tables
// and grouped shapes) and then its speaker notes. Slides cannot be rendered to images without
// extra software; see docs/tech-plan.md, Known limitations.

type XmlNode = Record<string, unknown>

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  parseTagValue: false,
  processEntities: true
})

const TITLE_LINE_SIZE = 28
const BODY_LINE_SIZE = 18
const NOTES_LINE_SIZE = 12
const LINE_STEP = 30
/** Placeholders on a notes page that hold no notes (slide picture, slide number, header, footer, date). */
const NOTES_SKIP = new Set(['sldImg', 'sldNum', 'hdr', 'ftr', 'dt'])

interface Slide {
  title: string | null
  paragraphs: string[]
  notes: string[]
  /** Share of the slide covered by pictures, 0..1. */
  pictureCoverage: number
}

export async function openPptx(path: string): Promise<DocumentSource> {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(await readFile(path)), {
      filter: (file) => file.name.endsWith('.xml') || file.name.endsWith('.rels')
    })
  } catch (error) {
    throw new Error('This file is not a readable PowerPoint (.pptx) file.', { cause: error })
  }
  const xml = (name: string): XmlNode[] | null => {
    const data = files[name]
    return data ? (parser.parse(strFromU8(data)) as XmlNode[]) : null
  }

  const presentation = xml('ppt/presentation.xml')
  if (!presentation) throw new Error('This file is not a PowerPoint (.pptx) deck: ppt/presentation.xml is missing.')
  const presentationRels = relationships(xml('ppt/_rels/presentation.xml.rels'), 'ppt/presentation.xml')
  const size = find(presentation, 'p:sldSz')
  const slideArea = Number(attr(size, 'cx') ?? 0) * Number(attr(size, 'cy') ?? 0)

  const slides: Slide[] = []
  for (const id of findAll(presentation, 'p:sldId')) {
    const slidePath = presentationRels.get(attr(id, 'r:id') ?? '')
    const slideXml = slidePath ? xml(slidePath) : null
    if (!slidePath || !slideXml) continue
    const slideRels = relationships(xml(relsPathOf(slidePath)), slidePath)
    const notesPath = [...slideRels.values()].find((target) => target.includes('/notesSlides/'))
    slides.push(readSlide(slideXml, notesPath ? xml(notesPath) : null, slideArea))
  }

  const core = xml('docProps/core.xml')
  const deckTitle = core ? textOf(find(core, 'dc:title')).trim() : ''
  return new PptxSource(slides, deckTitle || null)
}

class PptxSource implements DocumentSource {
  readonly pageCount: number

  constructor(
    private readonly slides: Slide[],
    private readonly deckTitle: string | null
  ) {
    this.pageCount = slides.length
  }

  async pageLabels(): Promise<null> {
    return null
  }

  async outline(): Promise<OutlineEntry[]> {
    const entries: OutlineEntry[] = []
    if (this.deckTitle) entries.push({ title: this.deckTitle, level: 1, page: 1, y: 0 })
    let previous: string | null = null
    this.slides.forEach((slide, i) => {
      // Consecutive slides with the same title ("... (continued)") stay in one section.
      const title = slide.title?.replace(/\s*\((cont(inued)?\.?)\)\s*$/i, '') ?? null
      if (title && title !== previous) entries.push({ title, level: 2, page: i + 1, y: 0 })
      if (title) previous = title
    })
    return entries
  }

  async readPage(pageIndex: number): Promise<PageContent> {
    const slide = this.slides[pageIndex - 1]
    if (!slide) throw new Error(`Slide ${pageIndex} does not exist.`)
    const lines: TextLine[] = []
    const add = (text: string, size: number, bold: boolean): void => {
      lines.push({ text, x: 0, y: LINE_STEP * (lines.length + 1), size, bold })
    }
    if (slide.title) add(slide.title, TITLE_LINE_SIZE, true)
    for (const paragraph of slide.paragraphs) add(paragraph, BODY_LINE_SIZE, false)
    if (slide.notes.length > 0) {
      add('Speaker notes:', NOTES_LINE_SIZE, true)
      for (const note of slide.notes) add(note, NOTES_LINE_SIZE, false)
    }
    const text = lines.map((l) => l.text).join(' ')
    return {
      width: 1000,
      height: LINE_STEP * (lines.length + 2),
      lines,
      stats: {
        charCount: text.replace(/\s/g, '').length,
        imageCoverage: slide.pictureCoverage,
        pathOps: 0,
        mathFontChars: 0,
        mathSymbolChars: 0,
        mathLayoutLines: 0,
        lineCount: lines.length
      }
    }
  }

  async renderPage(): Promise<null> {
    return null
  }

  async close(): Promise<void> {}
}

function readSlide(slide: XmlNode[], notes: XmlNode[] | null, slideArea: number): Slide {
  let title: string | null = null
  const paragraphs: string[] = []
  for (const shape of findAll(slide, 'p:sp')) {
    const type = placeholderType(shape)
    const texts = paragraphsOf(shape)
    if ((type === 'title' || type === 'ctrTitle') && title === null) title = texts.join(' ') || null
    else paragraphs.push(...texts)
  }
  // Tables and other graphic frames hold text too.
  for (const frame of findAll(slide, 'p:graphicFrame')) paragraphs.push(...paragraphsOf(frame))

  let pictureArea = 0
  for (const picture of findAll(slide, 'p:pic')) {
    const ext = find(children(picture), 'a:ext')
    pictureArea += Number(attr(ext, 'cx') ?? 0) * Number(attr(ext, 'cy') ?? 0)
  }

  const notesText: string[] = []
  if (notes) {
    for (const shape of findAll(notes, 'p:sp')) {
      if (!NOTES_SKIP.has(placeholderType(shape) ?? '')) notesText.push(...paragraphsOf(shape))
    }
  }
  return {
    title,
    paragraphs,
    notes: notesText,
    pictureCoverage: slideArea > 0 ? Math.min(1, pictureArea / slideArea) : 0
  }
}

function placeholderType(shape: XmlNode): string | null {
  const ph = find(children(shape), 'p:ph')
  if (!ph) return null
  return attr(ph, 'type') ?? 'body'
}

/** The text of each paragraph (a:p) inside a node, skipping empty ones. */
function paragraphsOf(node: XmlNode): string[] {
  return findAll(children(node), 'a:p')
    .map((p) => textOf(p).replace(/\s+/g, ' ').trim())
    .filter((text) => text !== '')
}

/** All text inside a node: a:t runs, with line breaks (a:br) as spaces. */
function textOf(node: XmlNode | null): string {
  if (!node) return ''
  let text = ''
  for (const [key, value] of Object.entries(node)) {
    if (key === ':@') continue
    if (key === '#text') text += String(value)
    else if (key === 'a:br') text += ' '
    else if (Array.isArray(value)) for (const child of value as XmlNode[]) text += textOf(child)
  }
  return text
}

function tagOf(node: XmlNode): string | undefined {
  return Object.keys(node).find((key) => key !== ':@')
}

function children(node: XmlNode | null): XmlNode[] {
  const tag = node ? tagOf(node) : undefined
  const value = tag && node ? node[tag] : undefined
  return Array.isArray(value) ? (value as XmlNode[]) : []
}

function attr(node: XmlNode | null, name: string): string | undefined {
  const attributes = node?.[':@'] as Record<string, string> | undefined
  return attributes?.[name]
}

/** Every descendant element with the given tag, in document order (not looking inside matches). */
function findAll(nodes: XmlNode[], tag: string): XmlNode[] {
  const found: XmlNode[] = []
  for (const node of nodes) {
    if (tagOf(node) === tag) found.push(node)
    else found.push(...findAll(children(node), tag))
  }
  return found
}

function find(nodes: XmlNode[], tag: string): XmlNode | null {
  return findAll(nodes, tag)[0] ?? null
}

/** Maps relationship ids to part paths inside the package. */
function relationships(rels: XmlNode[] | null, ownerPath: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!rels) return map
  const baseDir = posix.dirname(ownerPath)
  for (const rel of findAll(rels, 'Relationship')) {
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    if (!id || !target || attr(rel, 'TargetMode') === 'External') continue
    map.set(id, target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(baseDir, target)))
  }
  return map
}

function relsPathOf(partPath: string): string {
  return posix.join(posix.dirname(partPath), '_rels', `${posix.basename(partPath)}.rels`)
}
