import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { registerIpcHandlers } from './ipc'
import { createGeminiAdapter, ProviderService } from './providers'
import { openDatabase, SettingsStore } from './storage'

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

function isAppUrl(url: string): boolean {
  if (isDev && rendererDevUrl) return url.startsWith(rendererDevUrl)
  return url.startsWith('file://')
}

void app.whenReady().then(() => {
  const db = openDatabase(join(app.getPath('userData'), 'feynmind.db'))
  app.on('will-quit', () => db.close())

  const providers = new ProviderService({
    settings: new SettingsStore(db),
    encryptor: safeStorage,
    createAdapter: createGeminiAdapter,
    devKey: readDevKey(),
    loadPrompt
  })
  registerIpcHandlers(providers, (event) => isAppUrl(event.senderFrame?.url ?? ''))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
