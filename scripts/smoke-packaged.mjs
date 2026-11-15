// Smoke-tests the packaged app built by `npm run dist` on this OS.
//
// 1. Checks the built app.asar contains every runtime dependency (scripts/check-runtime-deps.mjs).
// 2. Copies the unpacked app OUTSIDE the repository. Inside the repo, Node's module lookup climbs
//    out of app.asar into the repo's node_modules and hides missing packages (the v0.0.1 bug).
// 3. Launches it with a throwaway profile and no API key, waits for the window and the database.
// 4. Imports two small fixture PDFs (one needs text recognition), waits until both are read and
//    indexed, and checks that a search returns the right passage with its printed page number.
//    This exercises every native and WASM part (PDF.js, canvas, Tesseract, sqlite-vec, ONNX).
//    The only network use is the one-time embedding model download into the throwaway profile.
//    Set FEYNMIND_SMOKE_MODEL_CACHE to a folder to reuse the model between runs (CI caches it);
//    the app verifies the model's checksums either way.
// 5. Dictation: downloads the Whisper tiny model through Settings (or copies it from the cache),
//    runs "Check speed on this computer" on the clip that ships with the app, then records a short
//    fixture clip through a fake microphone (Chromium's fake capture device, so the app's
//    permission handler, the recognition process and the ONNX runtime are all exercised) and
//    checks the transcript.
// 6. Fails on any uncaught exception, then quits.
//
// Exits non-zero if anything goes wrong. Usage: node scripts/smoke-packaged.mjs
/* global window, AudioContext -- used inside page.evaluate, which runs in the app window */
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
const INGEST_TIMEOUT_MS = 300_000
const OVERALL_TIMEOUT_MS = 480_000
const FIXTURES = join(root, 'tests', 'fixtures')
const MODEL_FOLDER = 'bge-small-en-v1.5-ea104dac'
const SPEECH_FOLDER = 'whisper-tiny.en-794207fe'
const MIC_CLIP = join(FIXTURES, 'audio', 'speech-9s.wav')
const modelCache = process.env['FEYNMIND_SMOKE_MODEL_CACHE']
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

// 1b. Every prompt file ships unchanged next to app.asar (the app reads them at runtime).
const promptsDir = join(build.dir, dirname(build.asar), 'prompts')
for (const name of readdirSync(join(root, 'prompts'))) {
  const shipped = join(promptsDir, name)
  if (!existsSync(shipped)) fail(`The build is missing prompts/${name}.`)
  if (!readFileSync(shipped).equals(readFileSync(join(root, 'prompts', name)))) fail(`prompts/${name} in the build differs from the repository.`)
}
console.log(`Prompts: ${readdirSync(join(root, 'prompts')).length} files present and unchanged.`)

// 2. Copy outside the repository.
const workDir = mkdtempSync(join(tmpdir(), 'feynmind-smoke-'))
const appDir = join(workDir, 'app')
cpSync(build.dir, appDir, { recursive: true, verbatimSymlinks: true })
const executablePath = join(appDir, build.exe)
const userDataDir = join(workDir, 'user-data')
if (modelCache && existsSync(join(modelCache, MODEL_FOLDER))) {
  cpSync(join(modelCache, MODEL_FOLDER), join(userDataDir, 'models', MODEL_FOLDER), { recursive: true })
  console.log(`Using the cached embedding model from ${modelCache}`)
}
if (modelCache && existsSync(join(modelCache, SPEECH_FOLDER))) {
  cpSync(join(modelCache, SPEECH_FOLDER), join(userDataDir, 'models', SPEECH_FOLDER), { recursive: true })
  console.log(`Using the cached speech model from ${modelCache}`)
}
console.log(`Launching ${executablePath}`)

// 3. Launch.
// No API key (so no network calls) and nothing that would make Electron behave like dev or plain Node.
const STRIPPED = new Set(['GEMINI_API_KEY', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'FEYNMIND_MODEL_DOWNLOAD'])
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
    // A fake microphone plays the fixture clip once; the permission prompt still goes through the app.
    // On macOS the fake device reads the file inside Chromium's sandboxed audio service, whose
    // sandbox profile blocks reading arbitrary files ("Failed to read ... as input to the fake
    // device"), so the test lifts that one process's sandbox there. A real microphone does not need
    // this: the profile allows the system audio capture it exists for.
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      ...(process.platform === 'darwin' ? ['--disable-features=AudioServiceSandbox'] : []),
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${MIC_CLIP}%noloop`
    ],
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
  await page.getByRole('heading', { name: 'Materials', level: 1 }).waitFor({ timeout: LAUNCH_TIMEOUT_MS })

  const info = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
    packaged: electronApp.isPackaged,
    windows: BrowserWindow.getAllWindows().length
  }))
  if (!info.packaged) throw new Error('The launched app does not report itself as packaged.')
  if (info.windows !== 1) throw new Error(`Expected 1 window, found ${info.windows}.`)
  if (!existsSync(join(userDataDir, 'feynmind.db'))) throw new Error('The database was not created (better-sqlite3 failed to load?).')

  // Import two fixtures through the real "Add files" button, with the file dialog answered for us.
  const files = [join(FIXTURES, 'openstax-precalculus-text.pdf'), join(FIXTURES, 'openstax-precalculus-scanned.pdf')]
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
  }, files)
  await page.getByRole('button', { name: 'Add files' }).click()
  for (const name of ['openstax-precalculus-text.pdf', 'openstax-precalculus-scanned.pdf']) {
    const stage = page.getByTestId('material').filter({ hasText: name }).getByTestId('material-stage')
    await stage.filter({ hasText: /^(Ready|Failed)/ }).waitFor({ timeout: INGEST_TIMEOUT_MS })
    const text = await stage.textContent()
    if (!text?.startsWith('Ready')) throw new Error(`${name} did not import: ${text}`)
  }
  const counts = await page.getByTestId('material').filter({ hasText: 'openstax-precalculus-scanned.pdf' }).getByTestId('material-counts').textContent()
  if (!counts?.includes('2 recognized from images')) throw new Error(`Text recognition did not run on the scanned fixture: ${counts}`)

  await page.getByLabel('Search your materials').fill('What is the domain of a function in a horror movie example?')
  await page.getByRole('button', { name: 'Search' }).click()
  const first = page.getByTestId('search-result').first()
  await first.waitFor({ timeout: LAUNCH_TIMEOUT_MS })
  const result = await first.textContent()
  if (await page.getByText('Keyword search only').count()) throw new Error('Search fell back to keywords: the embedding model did not load.')
  if (!result?.includes('1.2. Domain and Range') || !result.includes('p. 22 (PDF 5)')) {
    throw new Error(`Unexpected top search result: ${result}`)
  }
  console.log(`Search returned: ${result.slice(0, 120)}…`)

  if (modelCache && !existsSync(join(modelCache, MODEL_FOLDER))) {
    cpSync(join(userDataDir, 'models', MODEL_FOLDER), join(modelCache, MODEL_FOLDER), { recursive: true })
    console.log(`Saved the embedding model to ${modelCache}`)
  }

  // Dictation: the speech model, the speed check on the bundled clip, then the microphone path.
  await page.getByRole('button', { name: 'Settings' }).click()
  const tiny = page.getByTestId('speech-model-tiny.en')
  if (!(await tiny.getByText('Downloaded.').count())) {
    await tiny.getByRole('button', { name: 'Download' }).click()
    await tiny.getByText('Downloaded.').waitFor({ timeout: INGEST_TIMEOUT_MS })
  }
  await page.getByRole('button', { name: 'Check speed on this computer' }).click()
  const speed = page.getByTestId('speed-result')
  await speed.waitFor({ timeout: INGEST_TIMEOUT_MS })
  const speedText = (await speed.textContent()) ?? ''
  if (!/pictures/i.test(speedText)) throw new Error(`The speed check did not transcribe its clip: ${speedText}`)
  console.log(`Speed check: ${speedText.split('It heard')[0]?.trim()}`)

  // The renderer's own bridge and microphone, as the lesson screen uses them (16 kHz chunks).
  const heard = await page.evaluate(async () => {
    const api = window.feynmind
    const unwrap = (r) => {
      if (!r.ok) throw new Error(r.error)
      return r.value
    }
    unwrap(await api['dictation:prepareMic']())
    const { recordingId } = unwrap(await api['dictation:start']())
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    const context = new AudioContext({ sampleRate: 16000 })
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(4096, 1, 1)
    const mute = context.createGain()
    mute.gain.value = 0
    processor.onaudioprocess = (e) => void api['dictation:audio']({ recordingId, samples: new Float32Array(e.inputBuffer.getChannelData(0)) })
    source.connect(processor)
    processor.connect(mute)
    mute.connect(context.destination)
    await new Promise((resolve) => setTimeout(resolve, 11_000))
    processor.onaudioprocess = null
    stream.getTracks().forEach((t) => t.stop())
    await context.close()
    return unwrap(await api['dictation:stop']({ recordingId })).text
  })
  if (heard === '') throw new Error('The microphone clip was not transcribed: no speech reached the app. If the log below says the fake device failed to read the file, Chromium could not open the fixture clip.')
  if (!/different quality to mathematics/i.test(heard)) throw new Error(`The microphone clip was not transcribed as expected: "${heard}"`)
  console.log(`Dictation heard: ${heard}`)
  if (modelCache && !existsSync(join(modelCache, SPEECH_FOLDER))) {
    cpSync(join(userDataDir, 'models', SPEECH_FOLDER), join(modelCache, SPEECH_FOLDER), { recursive: true })
    console.log(`Saved the speech model to ${modelCache}`)
  }

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
console.log(`Smoke test passed: ${productName} ${pkg.version} opened, imported and searched the fixtures, transcribed speech, and quit cleanly.`)
