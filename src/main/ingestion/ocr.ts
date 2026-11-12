import { createRequire } from 'node:module'
import { join } from 'node:path'
import type Tesseract from 'tesseract.js'
import { packageDir } from './packagePaths'
import type { TextLine } from './types'

const require = createRequire(import.meta.url)

export interface OcrResult {
  lines: TextLine[]
  /** Tesseract's mean confidence for the page, 0..100. */
  confidence: number
}

/** Local text recognition for scanned pages. */
export interface OcrEngine {
  /**
   * Reads a rendered page. `scale` is image pixels per PDF unit, used to convert positions back
   * to PDF units so recognized lines line up with the outline.
   */
  recognize(png: Buffer, scale: number): Promise<OcrResult>
  close(): Promise<void>
}

/**
 * Tesseract with the bundled English data (@tesseract.js-data/eng), so no download is needed.
 * The worker starts on first use and runs in its own thread.
 */
export function createTesseractOcr(): OcrEngine {
  let worker: Promise<Tesseract.Worker> | null = null

  const start = (): Promise<Tesseract.Worker> => {
    const tesseract = require('tesseract.js') as typeof Tesseract
    return tesseract.createWorker('eng', tesseract.OEM.LSTM_ONLY, {
      langPath: join(packageDir('@tesseract.js-data/eng'), '4.0.0_best_int'),
      gzip: true,
      // Read the language data from the app; never write a cache file into the working folder.
      cacheMethod: 'none',
      // The worker script must be loaded from the unpacked copy in a packaged app.
      workerPath: join(packageDir('tesseract.js'), 'src', 'worker-script', 'node', 'index.js')
    })
  }

  return {
    async recognize(png, scale) {
      worker ??= start()
      const result = await (await worker).recognize(png, {}, { text: false, blocks: true })
      const lines: TextLine[] = []
      for (const block of result.data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            const text = line.text.replace(/\s+/g, ' ').trim()
            if (text === '') continue
            const height = (line.bbox.y1 - line.bbox.y0) / scale
            lines.push({
              text,
              x: round(line.bbox.x0 / scale),
              y: round(line.bbox.y1 / scale),
              size: round(height * 0.8),
              bold: false
            })
          }
        }
      }
      return { lines, confidence: Math.round(result.data.confidence) }
    },
    async close() {
      const running = worker
      worker = null
      if (running) await (await running).terminate()
    }
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}
