import type { TextLine } from './types'

/** One block of a vision model's transcription, starting at extracted line `fromLine` of the page. */
export interface TranscriptBlock {
  fromLine: number
  text: string
}

/** Font size used to place blocks on a page that had no extracted lines at all. */
const FALLBACK_SIZE = 10

/**
 * Turns a page's transcription into lines the chunker can use. Each block takes the position of
 * the extracted line it starts at, so section boundaries in the middle of a page still fall in the
 * right place, and carries the extracted text it replaces (from its line up to the next block's).
 */
export function transcribedLines(original: TextLine[], blocks: TranscriptBlock[]): TextLine[] {
  const sorted = [...blocks].sort((a, b) => a.fromLine - b.fromLine)
  return sorted
    .map((block, i) => {
      const anchor = original[block.fromLine] ?? original.at(-1)
      const nextFrom = sorted[i + 1]?.fromLine ?? original.length
      const replaced = original.slice(block.fromLine, Math.max(block.fromLine, nextFrom)).map((l) => l.text)
      return {
        text: block.text.trim(),
        x: anchor?.x ?? 0,
        y: anchor?.y ?? 0,
        size: anchor?.size ?? FALLBACK_SIZE,
        bold: false,
        original: replaced.join('\n')
      }
    })
    .filter((line) => line.text !== '')
}
