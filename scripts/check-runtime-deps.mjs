// Checks that every runtime dependency of the main process will be (or was) packaged.
//
// Why: electron-builder copies a package into app.asar only when its parent lists it under
// `dependencies` or `optionalDependencies`. Packages that are only ever *peer* dependencies
// (e.g. zod for the Vercel AI SDK) are silently left out, and the packaged app fails to start.
//
// Usage:
//   node scripts/check-runtime-deps.mjs                 # check package.json (runs in CI on every push)
//   node scripts/check-runtime-deps.mjs --asar <path>   # also check a built app.asar contains everything
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Finds an installed package the way Node does: walk up node_modules folders from `fromDir`. */
function locate(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir || !parent.startsWith(root)) return null
    dir = parent
  }
}

const readPkg = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

/** Every package the app needs at runtime, keyed by name@version. */
const closure = new Map()
/** Packages electron-builder will collect (reachable through dependencies/optionalDependencies only). */
const collected = new Set()
const problems = []

function visit(name, fromDir, requiredBy, viaPeer) {
  const dir = locate(name, fromDir)
  if (!dir) {
    problems.push(`${name} (needed by ${requiredBy}) is not installed. Run npm ci.`)
    return
  }
  const pkg = readPkg(dir)
  const id = `${pkg.name}@${pkg.version}`
  if (!viaPeer) collected.add(pkg.name)
  if (closure.has(id)) {
    if (!viaPeer && !closure.get(id).collected) {
      closure.get(id).collected = true
      walkChildren(pkg, dir, id)
    }
    return
  }
  closure.set(id, { name: pkg.name, version: pkg.version, collected: !viaPeer })
  walkChildren(pkg, dir, id)
}

function walkChildren(pkg, dir, id) {
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir, id, false)
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
    if (locate(dep, dir)) visit(dep, dir, id, false)
  }
  for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
    const optional = pkg.peerDependenciesMeta?.[peer]?.optional === true
    if (optional && !locate(peer, dir)) continue
    visit(peer, dir, `${id} (peer)`, true)
  }
}

for (const dep of Object.keys(rootPkg.dependencies ?? {})) visit(dep, root, 'package.json', false)

// 1. Every peer in the runtime tree must also be reachable as a regular dependency.
for (const { name, version } of closure.values()) {
  if (!collected.has(name)) {
    problems.push(
      `${name}@${version} is only a peer dependency in the production tree, so electron-builder ` +
        `will not package it. Add it to "dependencies" in package.json.`
    )
  }
}

// 2. Optionally, check a built app.asar actually contains every runtime package.
const asarIndex = process.argv.indexOf('--asar')
if (asarIndex !== -1) {
  const asarPath = resolve(process.argv[asarIndex + 1] ?? '')
  const require = createRequire(join(root, 'package.json'))
  const asar = require('@electron/asar')
  const packaged = new Set()
  for (const file of asar.listPackage(asarPath)) {
    const parts = file.split(/[\\/]/).filter(Boolean)
    if (parts.at(-1) !== 'package.json') continue
    const nm = parts.lastIndexOf('node_modules')
    if (nm === -1) continue
    const name = parts[nm + 1]?.startsWith('@') ? `${parts[nm + 1]}/${parts[nm + 2]}` : parts[nm + 1]
    const depth = name?.startsWith('@') ? nm + 3 : nm + 2
    if (name && parts.length === depth + 1) {
      const manifest = JSON.parse(asar.extractFile(asarPath, join(...parts)).toString('utf8'))
      packaged.add(`${manifest.name}@${manifest.version}`)
    }
  }
  for (const id of closure.keys()) {
    if (!packaged.has(id)) problems.push(`${id} is a runtime dependency but is missing from ${asarPath}`)
  }
  if (problems.length === 0) console.log(`app.asar contains all ${closure.size} runtime packages.`)
}

if (problems.length > 0) {
  console.error(`Runtime dependency check failed:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log(`Runtime dependency check passed (${closure.size} packages, no peer-only dependencies).`)
