import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * The folder of an installed package. In a packaged app, folders listed under asarUnpack in
 * electron-builder.yml live next to app.asar, and this returns that unpacked copy: native
 * libraries, WASM files and worker scripts cannot be used from inside the archive.
 */
export function packageDir(name: string): string {
  let dir = dirname(require.resolve(name))
  while (!existsSync(join(dir, 'package.json')) || !dir.replaceAll('\\', '/').endsWith(name)) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`Cannot find the folder of package ${name}.`)
    dir = parent
  }
  return unpacked(dir)
}

/** Maps a path inside app.asar to its unpacked copy; other paths are returned unchanged. */
export function unpacked(path: string): string {
  return path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`).replace('app.asar/', 'app.asar.unpacked/')
}
