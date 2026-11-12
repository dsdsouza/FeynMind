import { copyFile, mkdir, open, rename, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { AddMaterialsResult, MaterialKind } from '../../shared/ingestion'
import { sha256File } from './modelStore'
import type { IngestionRepo } from './repo'

const KINDS: Record<string, MaterialKind> = { '.pdf': 'pdf', '.pptx': 'pptx' }

/**
 * Adds files to a session. Each file is identified by the SHA-256 of its content, so the same file
 * (even renamed) is never added or processed twice in a session. Files are copied into
 * `materialsDir` under their hash, so later steps work even if the original is moved or deleted.
 */
export async function importFiles(paths: string[], sessionId: number, repo: IngestionRepo, materialsDir: string): Promise<AddMaterialsResult> {
  const result: AddMaterialsResult = { added: [], duplicates: [], rejected: [] }
  await mkdir(materialsDir, { recursive: true })
  for (const path of paths) {
    const name = basename(path)
    try {
      const kind = await detectKind(path)
      const size = (await stat(path)).size
      const sha256 = await sha256File(path)
      if (repo.findMaterialBySha(sessionId, sha256)) {
        result.duplicates.push(name)
        continue
      }
      const storedName = `${sha256}.${kind}`
      const stored = join(materialsDir, storedName)
      if (!existsSync(stored)) {
        // Copy under a temporary name first, so a crash never leaves a partial file under the real name.
        const partial = `${stored}.part`
        await copyFile(path, partial)
        await rename(partial, stored)
      }
      repo.insertMaterial({ sessionId, sha256, originalName: name, storedName, kind, byteSize: size })
      result.added.push(name)
    } catch (error) {
      result.rejected.push({ name, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/** Checks the extension and the file's first bytes, so a renamed file of another type is rejected early. */
async function detectKind(path: string): Promise<MaterialKind> {
  const extension = extname(path).toLowerCase()
  if (extension === '.ppt') throw new Error('Old PowerPoint (.ppt) files are not supported. Save the deck as .pptx and add it again.')
  const kind = KINDS[extension]
  if (!kind) throw new Error('Only PDF and PowerPoint (.pptx) files can be added.')
  const info = await stat(path)
  if (!info.isFile()) throw new Error('This is not a file.')
  if (info.size === 0) throw new Error('This file is empty.')
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(1024)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    const start = head.subarray(0, bytesRead)
    // PDF files start with %PDF (sometimes after a few junk bytes); .pptx files are zip archives.
    if (kind === 'pdf' && !start.includes(Buffer.from('%PDF'))) throw new Error('This file is not a PDF.')
    if (kind === 'pptx' && !(start[0] === 0x50 && start[1] === 0x4b)) throw new Error('This file is not a PowerPoint (.pptx) file.')
  } finally {
    await handle.close()
  }
  return kind
}
