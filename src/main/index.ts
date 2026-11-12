import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron'
import type { IpcEvent, IpcEvents } from '../shared/ipc'
import { IngestionService } from './ingestion'
import ingestionWorkerPath from './ingestion/worker?modulePath'
import { registerIpcHandlers } from './ipc'
import { createGeminiAdapter, ProviderService } from './providers'
import { openDatabase, SessionStore, SettingsStore } from './storage'

// Lets end-to-end tests run against a throwaway profile instead of the user's real data.
const userDataOverride = process.env['FEYNMIND_USER_DATA_DIR']
if (userDataOverride) app.setPath('userData', userDataOverride)

const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']
const isDev = !app.isPackaged && rendererDevUrl !== undefined

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

void app.whenReady().then(() => {
  const dataDir = app.getPath('userData')
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
    onModelStatus: (status) => broadcast('models:progress', status)
  })
  ingestion.start()
  // Let the worker finish its current page before the app exits; anything unfinished resumes next time.
  let stopped = false
  app.on('before-quit', (event) => {
    if (stopped) return
    event.preventDefault()
    void ingestion.stop().finally(() => {
      stopped = true
      app.quit()
    })
  })

  const providers = new ProviderService({
    settings: new SettingsStore(db),
    encryptor: safeStorage,
    createAdapter: createGeminiAdapter,
    devKey: readDevKey(),
    loadPrompt
  })
  registerIpcHandlers({ providers, ingestion, sessions: new SessionStore(db), pickMaterialFiles }, (event) =>
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
