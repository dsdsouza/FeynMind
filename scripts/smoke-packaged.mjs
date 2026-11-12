// Smoke-tests the packaged app built by `npm run dist` on this OS.
//
// 1. Checks the built app.asar contains every runtime dependency (scripts/check-runtime-deps.mjs).
// 2. Copies the unpacked app OUTSIDE the repository. Inside the repo, Node's module lookup climbs
//    out of app.asar into the repo's node_modules and hides missing packages (the v0.0.1 bug).
// 3. Launches it with a throwaway profile and no API key (so no network calls), waits for the
//    settings screen and the database, fails on any uncaught exception, then quits.
//
// Exits non-zero if anything goes wrong. Usage: node scripts/smoke-packaged.mjs
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const require = createRequire(join(root, 'package.json'))
const { _electron: electron } = require('@playwright/test')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const productName = pkg.productName ?? pkg.name
const releaseDir = join(root, 'release', pkg.version)

const LAUNCH_TIMEOUT_MS = 60_000
const OVERALL_TIMEOUT_MS = 180_000
const FATAL_OUTPUT = /Uncaught Exception|A JavaScript error occurred|ERR_MODULE_NOT_FOUND|Cannot find (module|package)/i

function fail(message, details = '') {
  console.error(`SMOKE TEST FAILED: ${message}${details ? `\n${details}` : ''}`)
  process.exit(1)
}

/** Where electron-builder put the unpacked app for this OS, and the paths inside it. */
function locateBuild() {
  if (process.platform === 'win32') {
    const dir = join(releaseDir, 'win-unpacked')
    return { dir, exe: `${productName}.exe`, asar: join('resources', 'app.asar') }
  }
  if (process.platform === 'darwin') {
    const preferred = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
    const dir = join(releaseDir, preferred)
    const app = `${productName}.app`
    return { dir, exe: join(app, 'Contents', 'MacOS', productName), asar: join(app, 'Contents', 'Resources', 'app.asar') }
  }
  const dir = join(releaseDir, 'linux-unpacked')
  const exe = existsSync(dir) ? readdirSync(dir).find((f) => f === pkg.name || f === productName) : undefined
  return { dir, exe: exe ?? pkg.name, asar: join('resources', 'app.asar') }
}

const build = locateBuild()
if (!existsSync(build.dir)) fail(`No unpacked build at ${build.dir}. Run npm run dist first.`)

// 1. Dependency check against the built archive.
const check = spawnSync(process.execPath, [join(root, 'scripts', 'check-runtime-deps.mjs'), '--asar', join(build.dir, build.asar)], {
  stdio: 'inherit'
})
if (check.status !== 0) fail('app.asar is missing runtime dependencies (see above).')

// 2. Copy outside the repository.
const workDir = mkdtempSync(join(tmpdir(), 'feynmind-smoke-'))
const appDir = join(workDir, 'app')
cpSync(build.dir, appDir, { recursive: true, verbatimSymlinks: true })
const executablePath = join(appDir, build.exe)
const userDataDir = join(workDir, 'user-data')
console.log(`Launching ${executablePath}`)

// 3. Launch.
// No API key (so no network calls) and nothing that would make Electron behave like dev or plain Node.
const STRIPPED = new Set(['GEMINI_API_KEY', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'])
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !STRIPPED.has(name))),
  FEYNMIND_USER_DATA_DIR: userDataDir
}

const output = []
const pageErrors = []
let app

/** Kills the app and its helper processes (on Windows, killing only the main process orphans them). */
function killApp() {
  const pid = app?.process().pid
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else app.process().kill('SIGKILL')
}

const watchdog = setTimeout(() => {
  killApp()
  fail(`Timed out after ${OVERALL_TIMEOUT_MS / 1000}s.`, output.join(''))
}, OVERALL_TIMEOUT_MS)

try {
  app = await electron.launch({
    executablePath,
    // GitHub's Linux runners cannot set up Chromium's setuid sandbox. The app's own
    // renderer sandbox (webPreferences.sandbox) is unaffected by this flag.
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
    env,
    timeout: LAUNCH_TIMEOUT_MS
  })
  const proc = app.process()
  proc.stdout?.on('data', (d) => output.push(String(d)))
  proc.stderr?.on('data', (d) => output.push(String(d)))
  const watchPage = (p) => p.on('pageerror', (error) => pageErrors.push(error.message))
  app.windows().forEach(watchPage)
  app.on('window', watchPage)

  const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS })
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor({ timeout: LAUNCH_TIMEOUT_MS })

  const info = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
    packaged: electronApp.isPackaged,
    windows: BrowserWindow.getAllWindows().length
  }))
  if (!info.packaged) throw new Error('The launched app does not report itself as packaged.')
  if (info.windows !== 1) throw new Error(`Expected 1 window, found ${info.windows}.`)
  if (!existsSync(join(userDataDir, 'feynmind.db'))) throw new Error('The database was not created (better-sqlite3 failed to load?).')

  await app.close()
} catch (error) {
  killApp()
  clearTimeout(watchdog)
  fail(error instanceof Error ? error.message : String(error), output.join(''))
}

clearTimeout(watchdog)
const fatal = output.join('').split('\n').filter((line) => FATAL_OUTPUT.test(line))
if (fatal.length > 0) fail('The main process logged a fatal error.', fatal.join('\n'))
if (pageErrors.length > 0) fail('The renderer threw an uncaught exception.', pageErrors.join('\n'))

try {
  rmSync(workDir, { recursive: true, force: true })
} catch {
  // Windows can keep files locked briefly after exit; the OS temp cleaner will remove them.
}
console.log(`Smoke test passed: ${productName} ${pkg.version} opened its window and quit cleanly.`)
