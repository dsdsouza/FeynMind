import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { fakeMicrophone, FIXTURES, killApp, launchApp } from './helpers'
import { MODEL_FOLDER, modelSource, processUnit, REPLAY } from './tutorSetup'

// Dictation in the built app, with a fake microphone fed from a fixture clip (LibriSpeech, read
// English; see tests/fixtures/README.md) and grades replayed from a file (no network): dictate
// "Your thinking", see the listening and transcribing states, edit the text, submit, and get a
// grade card that leads with the flawed-reasoning judgment. Also checks that no audio reached disk.
//
// Needs the embedding model and the Whisper tiny model, copied from FEYNMIND_SMOKE_MODEL_CACHE, the
// test:models cache or the development profile; skipped (saying why) when either is missing.

const SPEECH_FOLDER = 'whisper-tiny.en-794207fe'
const CLIP = join(FIXTURES, 'audio', 'speech-9s.wav')

function speechModelSource(): string | null {
  const dirs = [
    process.env['FEYNMIND_SMOKE_MODEL_CACHE'],
    process.env['FEYNMIND_MODEL_CACHE'] ?? join(tmpdir(), 'feynmind-model-cache'),
    process.env['APPDATA'] && join(process.env['APPDATA'], 'feynmind', 'models')
  ].filter((p): p is string => typeof p === 'string' && p !== '')
  return dirs.map((d) => join(d, SPEECH_FOLDER)).find((d) => existsSync(join(d, 'onnx', 'decoder_model_merged_quantized.onnx'))) ?? null
}

/** Every file under a folder, for checking that no recording was written. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

let userDataDir: string

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'feynmind-e2e-dictation-'))
})

test.afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

test('dictated reasoning appears as editable text and is graded with the answer', async () => {
  test.setTimeout(360_000)
  const embedding = modelSource()
  const speech = speechModelSource()
  test.skip(embedding === null, 'The embedding model is not on this machine. Run the app once to download it.')
  test.skip(speech === null, 'The Whisper tiny model is not on this machine. Run npm run test:models (or download it in Settings) first.')
  cpSync(embedding as string, join(userDataDir, 'models', MODEL_FOLDER), { recursive: true })
  cpSync(speech as string, join(userDataDir, 'models', SPEECH_FOLDER), { recursive: true })
  const replayFile = join(userDataDir, 'replay.json')
  writeFileSync(replayFile, JSON.stringify(REPLAY))

  const app = await launchApp(userDataDir, { FEYNMIND_PROVIDER_REPLAY: replayFile }, fakeMicrophone(CLIP))
  try {
    const page = await app.firstWindow()

    // Settings: tiny is selected and already on this computer; downloads are off in tests.
    await page.getByRole('button', { name: 'Settings' }).click()
    const tiny = page.getByTestId('speech-model-tiny.en')
    await expect(tiny.getByRole('radio')).toBeChecked()
    await expect(tiny).toContainText('Downloaded.')
    await expect(page.getByTestId('speech-model-base.en').getByRole('button', { name: 'Download' })).toBeDisabled()

    await processUnit(app, page)
    await page.getByRole('button', { name: 'Learn' }).click()
    await page.getByRole('button', { name: 'Start: relation' }).click()
    await expect(page.getByRole('heading', { name: 'Before we start' })).toBeVisible({ timeout: 30_000 })
    if (process.platform === 'win32') await expect(page.getByText('Windows key + H')).toBeVisible()
    if (process.platform === 'darwin') await expect(page.getByText('macOS Dictation')).toBeVisible()
    if (process.platform === 'linux') await expect(page.locator('.os-hint').filter({ hasText: /Windows key|macOS Dictation/ })).toHaveCount(0)

    // Dictate into "Your thinking" with the button; stop with the shortcut.
    await page.getByLabel('Your answer').fill('No, it is not a function.')
    await page.getByRole('button', { name: 'Dictate thinking' }).click()
    const state = page.getByTestId('dictation-state')
    await expect(state).toContainText('Listening', { timeout: 30_000 })
    await expect(page.getByLabel(/Your thinking/)).toHaveAttribute('readonly', '')
    await expect(page.getByRole('button', { name: 'Submit (Ctrl+Enter)' })).toBeDisabled()
    // Kill the recognition process mid-recording, as a crash would: it is logged, restarted, and
    // nothing said is lost.
    await expect(state).toContainText('0:03', { timeout: 30_000 })
    const killed = await app.evaluate(({ app: electronApp }) => {
      const worker = electronApp.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'FeynMind dictation')
      if (worker) process.kill(worker.pid)
      return worker?.pid ?? null
    })
    expect(killed).not.toBeNull()
    // Let the 9 s clip play out (it is followed by silence).
    await expect(state).toContainText('0:10', { timeout: 30_000 })
    await page.getByLabel(/Your thinking/).press('Control+Shift+Space')
    await expect(state).toContainText('Transcribing', { timeout: 10_000 })
    const thinking = page.getByLabel(/Your thinking/)
    await expect(thinking).toHaveValue(/different quality to mathematics/i, { timeout: 60_000 })
    await expect(state).toHaveCount(0)
    await expect(thinking).not.toHaveAttribute('readonly', '')
    expect(readFileSync(join(userDataDir, 'logs', 'exits.log'), 'utf8')).toMatch(/Dictation process exited unexpectedly with code -?\d+; restarting in 1 s/)
    expect(app.process().exitCode).toBeNull()

    // The text is editable, and is submitted and graded with the answer.
    await thinking.press('End')
    await thinking.pressSequentially(' So the input 1 has two outputs.')
    await expect(thinking).toHaveValue(/mathematics.*So the input 1 has two outputs\.$/is)
    await page.getByRole('button', { name: 'Submit (Ctrl+Enter)' }).click()
    await expect(page.getByTestId('attempt-reasoning')).toContainText('So the input 1 has two outputs.', { timeout: 30_000 })
    const grade = page.getByTestId('grade')
    await expect(grade).toContainText('Partly correct', { timeout: 30_000 })
    // Flawed reasoning leads the card, before the rubric reason that sounds like praise.
    await expect(grade.getByTestId('reasoning-cap')).toContainText('Faulty reasoning caps the grade at partly correct')
    const order = await grade.evaluate((card) => {
      const reasoning = card.querySelector('[data-testid="grade-reasoning"]')
      const reason = card.querySelector('[data-testid="grade-reason"]')
      // 4 is Node.DOCUMENT_POSITION_FOLLOWING: the rubric reason comes after the reasoning judgment.
      return reasoning && reason ? reasoning.compareDocumentPosition(reason) & 4 : 0
    })
    expect(order).toBeTruthy()

    // No audio was written anywhere in the profile.
    const audioFiles = filesUnder(userDataDir).filter((f) => /\.(wav|webm|ogg|opus|mp3|m4a|flac|pcm|raw)$/i.test(f))
    expect(audioFiles).toEqual([])
  } finally {
    await app.close().catch(() => killApp(app))
  }
})
