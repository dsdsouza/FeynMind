import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { FeynMindApi } from '../../src/shared/ipc'
import { FIXTURES, killApp, launchApp, stubFilePicker } from './helpers'

test.describe.configure({ mode: 'serial' })

let userDataDir: string

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'feynmind-e2e-'))
})

test.afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

function material(page: Page, name: string) {
  return page.getByTestId('material').filter({ hasText: name })
}

test('imports files without freezing the window, shows progress and flagged pages, and searches', async () => {
  test.setTimeout(180_000)
  const app = await launchApp(userDataDir)
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Materials', level: 1 })).toBeVisible()

    // Watch for long tasks (the renderer blocked for 200 ms or more) while the import runs.
    await page.evaluate(() => {
      const w = globalThis as unknown as { longTasks: number[] }
      w.longTasks = []
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (entry.duration >= 200) w.longTasks.push(entry.duration)
      }).observe({ type: 'longtask' as 'mark', buffered: false })
    })

    await stubFilePicker(app, [
      join(FIXTURES, 'openstax-precalculus-scanned.pdf'),
      join(FIXTURES, 'openstax-precalculus-text.pdf'),
      join(FIXTURES, 'openstax-precalculus-math-figures.pdf'),
      join(FIXTURES, 'vectors-dot-product.pptx')
    ])
    await page.getByRole('button', { name: 'Add files' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Added' })).toContainText('openstax-precalculus-scanned.pdf')
    // The search model is needed from the first import on; downloading it is turned off in tests.
    await expect(page.getByTestId('model-status')).toContainText('Downloading the search model is turned off')

    // While text recognition runs, the main process still answers quickly.
    const roundTrips: number[] = []
    for (let i = 0; i < 5; i++) {
      roundTrips.push(
        await page.evaluate(async () => {
          const started = performance.now()
          await (globalThis as unknown as { feynmind: FeynMindApi }).feynmind['sessions:current']()
          return performance.now() - started
        })
      )
      await page.getByRole('button', { name: 'Settings' }).click()
      await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({ timeout: 1_000 })
      await page.getByRole('button', { name: 'Materials' }).click()
      await expect(page.getByRole('heading', { name: 'Materials', level: 1 })).toBeVisible({ timeout: 1_000 })
    }
    expect(Math.max(...roundTrips)).toBeLessThan(500)

    // Every file is read; keyword search works without the model.
    for (const name of ['openstax-precalculus-scanned.pdf', 'openstax-precalculus-text.pdf', 'openstax-precalculus-math-figures.pdf']) {
      await expect(material(page, name).getByTestId('material-stage')).toContainText('waiting for the search model', { timeout: 120_000 })
    }
    await expect(material(page, 'vectors-dot-product.pptx').getByTestId('material-counts')).toContainText('4 of 4 slides read', { timeout: 60_000 })
    await expect(material(page, 'openstax-precalculus-scanned.pdf').getByTestId('material-counts')).toContainText('2 recognized from images')
    await expect(material(page, 'openstax-precalculus-math-figures.pdf').getByTestId('material-counts')).toContainText('2 math-heavy · 1 figure-heavy')
    expect(await page.evaluate(() => (globalThis as unknown as { longTasks: number[] }).longTasks)).toEqual([])

    // Flagged pages can be listed and viewed as images.
    const flagged = material(page, 'openstax-precalculus-math-figures.pdf')
    await flagged.getByRole('button', { name: 'Show pages that failed or were flagged' }).click()
    await expect(flagged.getByText('p. 808 (PDF 1): math-heavy')).toBeVisible()
    await flagged.getByRole('button', { name: 'View' }).first().click()
    await expect(flagged.getByRole('img', { name: /Page 808 of openstax-precalculus-math-figures.pdf/ })).toBeVisible({ timeout: 30_000 })

    // Search returns passages with file, section and printed page numbers.
    await page.getByLabel('Search your materials').fill('scary movie horror')
    await page.getByRole('button', { name: 'Search' }).click()
    const first = page.getByTestId('search-result').first()
    await expect(first).toContainText('openstax-precalculus-text.pdf')
    await expect(first).toContainText('1.2. Domain and Range')
    await expect(first.getByTestId('result-pages')).toContainText('p. 22 (PDF 5)')
    await expect(page.getByText('Keyword search only')).toBeVisible()

    // Quoting an exercise from deep inside a two-page passage: the result opens on that sentence,
    // with the quoted wording highlighted, and gives the page the exercise is printed on.
    await page.getByLabel('Search your materials').fill('evaluate the function f at the values f(−2), f(−1), f(0), f(1), and f(2)')
    await page.getByRole('button', { name: 'Search' }).click()
    const quoted = page.getByTestId('search-result').first()
    await expect(quoted.getByTestId('result-focus')).toHaveText(/^For the following exercises, evaluate the function f at the values/)
    await expect(quoted.getByTestId('result-focus').locator('mark').first()).toHaveText(/^evaluate the function f at the values/)
    await expect(quoted.getByTestId('result-pages')).toContainText('p. 21 (PDF 4)')
    await expect(quoted.getByTestId('result-passage-pages')).toContainText('passage pp. 3–21 (PDF 3–4)')
    await expect(quoted.getByTestId('result-snippet')).not.toContainText('If we consider the prices')
    await quoted.getByRole('button', { name: 'Show the whole passage' }).click()
    await expect(quoted.getByTestId('result-snippet')).toContainText('If we consider the prices')

    await page.getByLabel('Search your materials').fill('students forget to add the products')
    await page.getByRole('button', { name: 'Search' }).click()
    await expect(page.getByTestId('search-result').first().getByTestId('result-pages')).toContainText('slide 2')
  } finally {
    await app.close()
  }
})

test('continues an interrupted import after the app is killed and reopened', async () => {
  test.setTimeout(180_000)
  let app: ElectronApplication = await launchApp(userDataDir)
  let page = await app.firstWindow()
  await stubFilePicker(app, [join(FIXTURES, 'openstax-precalculus-scanned.pdf'), join(FIXTURES, 'openstax-precalculus-text.pdf')])
  await page.getByRole('button', { name: 'Add files' }).click()
  const scanned = () => material(page, 'openstax-precalculus-scanned.pdf')

  // Text recognition takes a few seconds a page: kill the app after the first scanned page.
  await expect(scanned().getByTestId('material-counts')).toContainText('1 of 2 pages read', { timeout: 60_000 })
  killApp(app)

  app = await launchApp(userDataDir)
  try {
    page = await app.firstWindow()
    await expect(scanned().getByTestId('material-counts')).toContainText('2 of 2 pages read', { timeout: 120_000 })
    await expect(material(page, 'openstax-precalculus-text.pdf').getByTestId('material-counts')).toContainText('6 of 6 pages read', {
      timeout: 60_000
    })
    // Each file was added once, and each page stored once.
    await expect(page.getByTestId('material')).toHaveCount(2)
    await expect(scanned().getByTestId('material-counts')).toContainText('2 recognized from images')
    // The killed run never quit cleanly, and the exit log says so.
    expect(readFileSync(join(userDataDir, 'logs', 'exits.log'), 'utf8')).toContain('did not shut down cleanly last time')
  } finally {
    await app.close()
  }
})

test('keeps the app running when the import process crashes, logs it, says so and carries on', async () => {
  test.setTimeout(180_000)
  const app = await launchApp(userDataDir)
  try {
    const page = await app.firstWindow()
    await stubFilePicker(app, [join(FIXTURES, 'openstax-precalculus-scanned.pdf'), join(FIXTURES, 'openstax-precalculus-text.pdf')])
    await page.getByRole('button', { name: 'Add files' }).click()
    const scanned = material(page, 'openstax-precalculus-scanned.pdf')
    await expect(scanned.getByTestId('material-counts')).toContainText('1 of 2 pages read', { timeout: 60_000 })

    // Kill only the import worker, as a crash would.
    const killed = await app.evaluate(({ app: electronApp }) => {
      const worker = electronApp.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'FeynMind ingestion')
      if (worker) process.kill(worker.pid)
      return worker?.pid ?? null
    })
    expect(killed).not.toBeNull()

    // The window stays up and explains what happened.
    const notice = page.getByTestId('worker-status')
    await expect(notice).toContainText('The background import stopped unexpectedly')
    await expect(notice).toContainText('It was restarted and continues where it left off', { timeout: 30_000 })
    await expect(notice).toContainText(join(userDataDir, 'logs', 'exits.log'))
    expect(app.process().exitCode).toBeNull()

    // The import finishes after the restart.
    await expect(scanned.getByTestId('material-counts')).toContainText('2 of 2 pages read', { timeout: 120_000 })
    await expect(material(page, 'openstax-precalculus-text.pdf').getByTestId('material-counts')).toContainText('6 of 6 pages read', {
      timeout: 60_000
    })
    expect(readFileSync(join(userDataDir, 'logs', 'exits.log'), 'utf8')).toMatch(/Ingestion worker exited unexpectedly with code -?\d+/)

    await notice.getByRole('button', { name: 'Dismiss' }).click()
    await expect(notice).toHaveCount(0)
  } finally {
    await app.close()
  }
  // A clean quit leaves no "did not shut down cleanly" line for the next start.
  expect(existsSync(join(userDataDir, 'logs', 'running'))).toBe(false)
})
