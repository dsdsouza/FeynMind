import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { FIXTURES, killApp, launchApp, stubFilePicker } from './helpers'

// The knowledge flow in the built app, with model replies replayed from a file (no network):
// import a syllabus and correct it, estimate a unit, confirm the notice, approve, kill the app
// mid-job, and check that it finishes after a restart without repeating any request. Then review
// and edit the concepts.
//
// Building the graph needs the local embedding model. Downloads are off in end-to-end tests, so
// the model is copied from FEYNMIND_SMOKE_MODEL_CACHE or from the development profile.

const MODEL_FOLDER = 'bge-small-en-v1.5-ea104dac'

function modelSource(): string | null {
  const candidates = [process.env['FEYNMIND_SMOKE_MODEL_CACHE'], process.env['APPDATA'] && join(process.env['APPDATA'], 'feynmind', 'models')].filter(
    (p): p is string => typeof p === 'string' && p !== ''
  )
  return candidates.map((dir) => join(dir, MODEL_FOLDER)).find((dir) => existsSync(dir)) ?? null
}

const REPLAY = {
  delayMs: 700,
  rules: [
    {
      schema: 'exams',
      reply: {
        units: [
          { title: 'Functions', topics: ['functions', 'domain and range'], startDate: '2026-09-01', endDate: '2026-09-20', examWeight: null, readings: ['1.1-1.2'] },
          { title: 'Matrices', topics: ['matrix operations'], startDate: null, endDate: null, examWeight: null, readings: ['9.5'] }
        ],
        exams: [{ title: 'Midterm', date: '2026-10-15', weight: 30, units: [0, 1] }]
      }
    },
    // Nothing is matched, so the user has to choose the sections in the editor.
    { schema: 'units', reply: { units: [{ unit: 0, toc: [] }, { unit: 1, toc: [] }] } },
    { schema: 'blocks', reply: { blocks: [{ fromLine: 0, text: 'Transcribed text with $x^2$ in LaTeX.' }] } },
    { schema: 'answers', reply: 'all-different' },
    {
      schema: 'concepts',
      contains: 'Section: 1.2',
      reply: { concepts: [{ name: 'domain', definition: 'The set of inputs of a function.', pages: ['FIRST_PAGE'], prerequisites: ['function'] }] }
    },
    {
      schema: 'concepts',
      contains: 'Section: 1.1',
      reply: {
        concepts: [
          { name: 'relation', definition: 'A set of ordered pairs.', pages: ['FIRST_PAGE'], prerequisites: [] },
          { name: 'function', definition: 'A relation with one output for each input.', pages: ['FIRST_PAGE'], prerequisites: ['relation'] }
        ]
      }
    },
    {
      schema: 'concepts',
      reply: { concepts: [{ name: 'matrix addition', definition: 'Adding matching entries of two matrices.', pages: ['FIRST_PAGE'], prerequisites: ['matrix'] }] }
    }
  ]
}

const SYLLABUS = `MATH 120 Precalculus, Fall 2026.
Weeks 1-3 (Sep 1 - Sep 20): Functions. Read 1.1 Functions and Function Notation and 1.2 Domain and Range.
Week 4: Matrices and matrix operations. Read 9.5.
Midterm on October 15 (30% of the grade).`

let userDataDir: string

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'feynmind-e2e-knowledge-'))
})

test.afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

function logLines(file: string): { keys: string[]; images: number; hash: string }[] {
  if (!existsSync(`${file}.log`)) return []
  return readFileSync(`${file}.log`, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { keys: string[]; images: number; hash: string })
}

async function selectModel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('combobox').first()).toHaveValue('replay-model', { timeout: 30_000 })
}

test('imports a syllabus, runs a unit after the estimate, survives a kill mid-job, and reviews the graph', async () => {
  test.setTimeout(300_000)
  const model = modelSource()
  test.skip(model === null, 'The embedding model is not on this machine. Run the app once (or npm run smoke with FEYNMIND_SMOKE_MODEL_CACHE) to download it.')
  cpSync(model as string, join(userDataDir, 'models', MODEL_FOLDER), { recursive: true })
  const replayFile = join(userDataDir, 'replay.json')
  writeFileSync(replayFile, JSON.stringify(REPLAY))
  const env = { FEYNMIND_PROVIDER_REPLAY: replayFile }

  let app = await launchApp(userDataDir, env)
  try {
    await run()
  } finally {
    // A graceful close lets every helper process release the profile folder before it is removed.
    await app.close().catch(() => killApp(app))
  }

  async function run(): Promise<void> {
  let page = await app.firstWindow()
  await selectModel(page)

  // Import the textbook fixtures and wait until they are searchable.
  await page.getByRole('button', { name: 'Materials' }).click()
  await stubFilePicker(app, [join(FIXTURES, 'openstax-precalculus-text.pdf'), join(FIXTURES, 'openstax-precalculus-math-figures.pdf')])
  await page.getByRole('button', { name: 'Add files' }).click()
  for (const name of ['openstax-precalculus-text.pdf', 'openstax-precalculus-math-figures.pdf']) {
    await expect(page.getByTestId('material').filter({ hasText: name }).getByTestId('material-stage')).toHaveText('Ready', { timeout: 120_000 })
  }

  // Syllabus: estimate first, nothing sent before approval and the notice.
  await page.getByRole('button', { name: 'Course' }).click()
  await page.getByLabel('Or paste the syllabus text').fill(SYLLABUS)
  await page.getByRole('button', { name: 'Use pasted text' }).click()
  await expect(page.getByTestId('estimate-calls')).toHaveText('2')
  expect(logLines(replayFile)).toHaveLength(0)
  await page.getByRole('button', { name: 'Approve and run' }).click()
  const notice = page.getByRole('alertdialog')
  await expect(notice).toContainText('Google Gemini')
  await expect(notice).toContainText('Free tiers of model providers may use what you send')
  await notice.getByRole('button', { name: 'I understand, continue' }).click()

  // Correct the reading: rename a unit and choose the sections the model did not match.
  await expect(page.getByRole('heading', { name: 'Check the syllabus' })).toBeVisible({ timeout: 30_000 })
  expect(logLines(replayFile)).toHaveLength(2)
  const unit1 = page.getByRole('listitem', { name: 'Unit 1' })
  await unit1.getByLabel('Title').fill('Functions and their domains')
  const sections = unit1.getByLabel('Sections it covers')
  const values = await sections.locator('option').evaluateAll((options) => options.map((o) => o.getAttribute('value') ?? ''))
  await sections.selectOption(values)
  await page.getByRole('button', { name: 'Save syllabus' }).click()

  // Unit 1 is selected by default; estimate, then approve (no second notice).
  await expect(page.getByLabel('Unit', { exact: true })).toContainText('1. Functions and their domains')
  await page.getByRole('button', { name: 'Estimate this unit' }).click()
  const estimate = page.getByTestId('estimate')
  await expect(estimate).toContainText('Transcribe flagged pages')
  const estimatedCalls = Number(await page.getByTestId('estimate-calls').textContent())
  expect(estimatedCalls).toBeGreaterThan(2)
  await estimate.getByRole('button', { name: 'Approve and run' }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)

  // Kill the app once a few of the unit's requests are done.
  await expect.poll(() => logLines(replayFile).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(4)
  killApp(app)
  const beforeKill = logLines(replayFile).length

  app = await launchApp(userDataDir, env)
  page = await app.firstWindow()
  await page.getByRole('button', { name: 'Course' }).click()
  await expect(page.getByRole('button', { name: 'Review concepts' })).toBeVisible({ timeout: 120_000 })

  // No request was sent twice: everything finished before the kill came from the cache.
  const lines = logLines(replayFile)
  expect(lines.length).toBeGreaterThan(beforeKill)
  const hashes = lines.map((l) => `${l.keys.join(',')}:${l.hash}`)
  expect(new Set(hashes).size).toBe(hashes.length)
  expect(lines.some((l) => l.images === 1)).toBe(true)
  await expect(page.getByTestId('usage')).toContainText(`${lines.length} calls`)

  // Review: concepts in learning order, page links open the page, edits stick.
  await page.getByRole('button', { name: 'Review concepts' }).click()
  await expect(page.getByRole('heading', { name: 'Concepts: Functions and their domains' })).toBeVisible()
  const names = await page.locator('.concept-name').allTextContents()
  const order = names.map((n) => n.replace(/\(edited\)/, '').trim())
  expect(order.indexOf('relation')).toBeLessThan(order.indexOf('function'))
  expect(order.indexOf('function')).toBeLessThan(order.indexOf('domain'))

  const domain = page.getByRole('listitem', { name: 'domain' })
  await expect(domain).toContainText('Prerequisites: function')
  await domain.getByRole('button', { name: /PDF/ }).first().click()
  await expect(page.locator('figure.preview img')).toBeVisible({ timeout: 30_000 })
  await page.locator('figure.preview').getByRole('button', { name: 'Close' }).click()

  await domain.getByRole('button', { name: 'Rename' }).click()
  await domain.getByLabel('Name').fill('domain of a function')
  await domain.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('listitem', { name: 'domain of a function' })).toContainText('(edited)')

  // A link that would make a loop is refused.
  const relation = page.getByRole('listitem', { name: 'relation' })
  await relation.getByRole('button', { name: 'Add prerequisite…' }).click()
  await relation.getByRole('combobox').selectOption({ label: 'domain of a function' })
  await relation.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('already depends on')
  }
})
