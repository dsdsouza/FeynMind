import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron'
import type { IpcEvent, IpcEvents } from '../shared/ipc'
import { ExitLog } from './exitLog'
import { IngestionService } from './ingestion'
import ingestionWorkerPath from './ingestion/worker?modulePath'
import { registerIpcHandlers } from './ipc'
import { KnowledgeService, PromptLibrary } from './knowledge'
import { createGeminiAdapter, createReplayAdapter, ProviderService, UsageStore } from './providers'
import { openDatabase, SessionStore, SettingsStore } from './storage'
import { TutorService } from './tutor'

// Lets end-to-end tests run against a throwaway profile instead of the user's real data.
const userDataOverride = process.env['FEYNMIND_USER_DATA_DIR']
if (userDataOverride) app.setPath('userData', userDataOverride)

const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']
const isDev = !app.isPackaged && rendererDevUrl !== undefined
/** End-to-end tests answer model requests from a file. Never honoured in a packaged app. */
const replayFile = !app.isPackaged ? (process.env['FEYNMIND_PROVIDER_REPLAY'] ?? null) : null

/**
 * In development only, read GEMINI_API_KEY from .env.local without copying it into process.env.
 * Returns null in packaged builds, in tests, or when the file or variable is missing.
 */
function readDevKey(): string | null {
  if (!isDev) return null
  try {
    const parsed = parseEnv(readFileSync(join(app.getAppPath(), '.env.local'), 'utf8'))
    const key = parsed['GEMINI_API_KEY']?.trim()
    return key ? key : null
  } catch {
    return null
  }
}

function promptsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'prompts') : join(app.getAppPath(), 'prompts')
}

function loadPrompt(name: string): string {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid prompt name: ${name}`)
  return readFileSync(join(promptsDir(), `${name}.txt`), 'utf8').trim()
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: 'FeynMind',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => window.show())

  // Open external links in the browser; never navigate the app window away from the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })

  if (isDev && rendererDevUrl) void window.loadURL(rendererDevUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  return window
}

/** Sends an event to every open window. */
function broadcast<E extends IpcEvent>(event: E, payload: IpcEvents[E]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(event, payload)
  }
}

async function pickSyllabusFile(): Promise<string | null> {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options: Electron.OpenDialogOptions = { title: 'Import syllabus', properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

async function pickMaterialFiles(): Promise<string[]> {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options: Electron.OpenDialogOptions = {
    title: 'Add course materials',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF and PowerPoint', extensions: ['pdf', 'pptx'] }]
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
}

function isAppUrl(url: string): boolean {
  if (isDev && rendererDevUrl) return url.startsWith(rendererDevUrl)
  return url.startsWith('file://')
}

/** Error stack frames without the message (which could hold anything); the message is added redacted. */
function stackFrames(error: unknown): string {
  const stack = error instanceof Error ? (error.stack ?? '') : ''
  return stack
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, 8)
    .join('\n')
}

/**
 * Records unexpected exits and crashes in <data folder>/logs/exits.log: helper and window processes
 * that go away, uncaught errors, termination signals, a non-zero exit code, and a previous run that
 * never quit cleanly. `describe` turns an error into a message with any API key removed.
 */
function watchForUnexpectedExits(exitLog: ExitLog, describe: () => (error: unknown) => string): void {
  exitLog.startRun(process.pid)
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    const name = details.name ?? details.serviceName ?? details.type
    exitLog.record(`${details.type} process (${name}) gone: reason ${details.reason}, exit code ${details.exitCode}.`)
  })
  app.on('render-process-gone', (_event, _contents, details) => {
    exitLog.record(`Window process gone: reason ${details.reason}, exit code ${details.exitCode}.`)
  })
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    exitLog.record(`Main process ${origin}: ${describe()(error)}\n${stackFrames(error)}`)
  })
  process.on('unhandledRejection', (reason) => {
    exitLog.record(`Main process unhandled promise rejection: ${describe()(reason)}\n${stackFrames(reason)}`)
  })
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      exitLog.record(`Main process received ${signal}; quitting.`)
      app.quit()
    })
  }
  app.on('quit', (_event, exitCode) => {
    if (exitCode !== 0) exitLog.record(`FeynMind quit with exit code ${exitCode}.`)
    exitLog.endRun()
  })
}

void app.whenReady().then(() => {
  const dataDir = app.getPath('userData')
  const exitLog = new ExitLog(join(dataDir, 'logs'))
  let describeError = (error: unknown): string => (error instanceof Error ? error.name : 'Unknown error')
  watchForUnexpectedExits(exitLog, () => describeError)
  const dbPath = join(dataDir, 'feynmind.db')
  const db = openDatabase(dbPath)
  app.on('will-quit', () => db.close())

  const ingestion = new IngestionService({
    db,
    workerPath: ingestionWorkerPath,
    init: {
      dbPath,
      materialsDir: join(dataDir, 'materials'),
      modelsDir: join(dataDir, 'models'),
      // Tests that must stay offline set FEYNMIND_MODEL_DOWNLOAD=off; search then uses keywords only.
      allowModelDownload: process.env['FEYNMIND_MODEL_DOWNLOAD'] !== 'off'
    },
    onProgress: (summary) => broadcast('ingestion:progress', summary),
    onModelStatus: (status) => broadcast('models:progress', status),
    onWorkerStatus: (status) => broadcast('ingestion:worker', status),
    recordExit: (message) => exitLog.record(message),
    exitLogPath: exitLog.path
  })
  ingestion.start()

  const sessions = new SessionStore(db)
  const settings = new SettingsStore(db)
  const providers = new ProviderService({
    settings,
    encryptor: safeStorage,
    createAdapter: replayFile ? createReplayAdapter(replayFile) : createGeminiAdapter,
    devKey: replayFile ? 'replay-key' : readDevKey(),
    loadPrompt,
    usage: new UsageStore(db),
    limits: (sessionId) => sessions.limits(sessionId)
  })
  describeError = (error) => providers.safeErrorMessage(error)
  const prompts = new PromptLibrary(loadPrompt)
  const knowledge = new KnowledgeService({
    db,
    providers,
    ingestion,
    prompts,
    settings,
    limits: (sessionId) => sessions.limits(sessionId),
    onJob: (job) => broadcast('knowledge:job', job),
    onUsage: (usage) => broadcast('usage:changed', usage)
  })
  knowledge.start()
  const tutor = new TutorService({
    db,
    providers,
    unitGraphs: (sessionId) => knowledge.unitGraphs(sessionId),
    retrieval: { reader: ingestion.reader, search: (sessionId, query) => ingestion.search(sessionId, query) },
    prompts,
    consentGiven: (sessionId) => knowledge.consent(sessionId).given,
    onLesson: (view) => broadcast('tutor:lesson', view),
    onStream: (event) => broadcast('tutor:stream', event),
    onUsage: (usage) => broadcast('usage:changed', usage)
  })

  // Let the worker finish its current page, and a model request in flight be cached, before the
  // app exits; anything unfinished resumes next time.
  let stopped = false
  app.on('before-quit', (event) => {
    if (stopped) return
    event.preventDefault()
    void Promise.allSettled([knowledge.stop(), tutor.stop(), ingestion.stop()]).finally(() => {
      stopped = true
      app.quit()
    })
  })

  registerIpcHandlers({ providers, ingestion, sessions, knowledge, tutor, pickMaterialFiles, pickSyllabusFile }, (event) =>
    isAppUrl(event.senderFrame?.url ?? '')
  )

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
