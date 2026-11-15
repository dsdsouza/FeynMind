import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication } from '@playwright/test'

// Playwright loads test files as CommonJS, so __dirname is available here.
export const FIXTURES = join(__dirname, '..', 'fixtures')

/**
 * Chromium switches that replace the microphone with a WAV file (played once, then silence). The
 * permission request still goes through the app's own handler.
 */
export function fakeMicrophone(wavPath: string): string[] {
  return ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}%noloop`]
}

/**
 * Launches the built app (npm run test:e2e builds first) with the given profile folder. No API key
 * and no model download: these tests make no network calls, so search is keyword-only here.
 */
export function launchApp(userDataDir: string, extraEnv: Record<string, string> = {}, extraArgs: string[] = []): Promise<ElectronApplication> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== 'GEMINI_API_KEY' && name !== 'ELECTRON_RENDERER_URL' && name !== 'ELECTRON_RUN_AS_NODE') {
      env[name] = value
    }
  }
  env['FEYNMIND_USER_DATA_DIR'] = userDataDir
  env['FEYNMIND_MODEL_DOWNLOAD'] = 'off'
  return electron.launch({ args: ['.', ...extraArgs], env: { ...env, ...extraEnv } })
}

/** Makes the next "Add files" pick the given files instead of showing the system dialog. */
export async function stubFilePicker(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: files })) as typeof dialog.showOpenDialog
  }, paths)
}

/** Kills the app and all its helper processes at once, as a crash or power cut would. */
export function killApp(app: ElectronApplication): void {
  const pid = app.process().pid
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else process.kill(-pid, 'SIGKILL')
}
