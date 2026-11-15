import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

// Runs the built app (npm run test:e2e builds first) against a throwaway profile.
// No key is available: GEMINI_API_KEY is stripped and the .env.local fallback only runs in dev,
// so this test makes no network calls.

let app: ElectronApplication
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'feynmind-e2e-'))
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== 'GEMINI_API_KEY' && name !== 'ELECTRON_RENDERER_URL' && name !== 'ELECTRON_RUN_AS_NODE') {
      env[name] = value
    }
  }
  env['FEYNMIND_USER_DATA_DIR'] = userDataDir
  env['FEYNMIND_MODEL_DOWNLOAD'] = 'off'
  app = await electron.launch({ args: ['.'], env })
})

test.afterAll(async () => {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })
})

test('opens the settings screen with no key configured', async () => {
  const page = await app.firstWindow()
  await expect(page).toHaveTitle('FeynMind')
  await expect(page.getByRole('heading', { name: 'Materials', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Gemini (Google)' })).toBeVisible()
  await expect(page.getByTestId('key-source')).toContainText('No key yet')
  await expect(page.getByRole('button', { name: 'Test' })).toBeDisabled()
})

test('keeps the renderer sandboxed and exposes only the typed bridge', async () => {
  const page = await app.firstWindow()
  const exposed = await page.evaluate(() => {
    const g = globalThis as { require?: unknown; process?: unknown; feynmind?: object }
    return {
      require: typeof g.require,
      process: typeof g.process,
      bridge: Object.keys(g.feynmind ?? {}).sort()
    }
  })
  expect(exposed.require).toBe('undefined')
  expect(exposed.process).toBe('undefined')
  expect(exposed.bridge).toEqual([
    'clock:report',
    'concepts:delete',
    'concepts:link',
    'concepts:merge',
    'concepts:rename',
    'concepts:review',
    'concepts:unlink',
    'consent:get',
    'consent:give',
    'dev:clock',
    'diagnostic:answer',
    'diagnostic:start',
    'diagnostic:state',
    'dictation:audio',
    'dictation:cancel',
    'dictation:cancelDownload',
    'dictation:download',
    'dictation:prepareMic',
    'dictation:selectModel',
    'dictation:speedCheck',
    'dictation:start',
    'dictation:status',
    'dictation:stop',
    'exams:list',
    'exams:update',
    'ingestion:status',
    'knowledge:approve',
    'knowledge:cancel',
    'knowledge:estimateUnit',
    'knowledge:jobs',
    'knowledge:pause',
    'knowledge:resume',
    'lesson:answer',
    'lesson:contest',
    'lesson:continue',
    'lesson:current',
    'lesson:draft',
    'lesson:interleaveAnswer',
    'lesson:more',
    'lesson:open',
    'lesson:retry',
    'materials:add',
    'materials:issues',
    'materials:list',
    'materials:renderPage',
    'models:retry',
    'models:status',
    'on',
    'provider:listModels',
    'provider:test',
    'reviews:answer',
    'reviews:contest',
    'reviews:current',
    'reviews:draft',
    'reviews:hint',
    'reviews:progress',
    'reviews:reteach',
    'reviews:reteachAnswer',
    'reviews:setLimit',
    'reviews:shown',
    'reviews:skipToday',
    'reviews:start',
    'reviews:today',
    'search:query',
    'sessions:current',
    'settings:clearKey',
    'settings:getState',
    'settings:saveKey',
    'settings:selectModel',
    'standing:claimKnown',
    'standing:markNew',
    'syllabus:get',
    'syllabus:importFile',
    'syllabus:importText',
    'syllabus:save',
    'tutor:path',
    'units:list',
    'usage:get',
    'usage:raiseCap',
    'usage:setLimits'
  ])
})
