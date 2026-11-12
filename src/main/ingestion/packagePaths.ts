import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * The folder of an installed package. In a packaged app, packages listed under asarUnpack in
 * electron-builder.yml also exist next to app.asar, and this returns that unpacked copy: native
 * libraries and worker scripts cannot be used from inside the archive.
 */
export function packageDir(name: string): string {
  let dir: string
  try {
    dir = dirname(require.resolve(`${name}/package.json`))
  } catch {
    // Packages whose "exports" hide package.json: walk up from the main file.
    dir = dirname(require.resolve(name))
    while (!existsSync(join(dir, 'package.json')) || !dir.replaceAll('\\', '/').endsWith(name)) {
      const parent = dirname(dir)
      if (parent === dir) throw new Error(`Cannot find the folder of package ${name}.`)
      dir = parent
    }
  }
  return unpacked(dir)
}

/** Maps a path inside app.asar to its unpacked copy when there is one; other paths are returned unchanged. */
export function unpacked(path: string): string {
  const candidate = path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  return candidate !== path && existsSync(candidate) ? candidate : path
}
