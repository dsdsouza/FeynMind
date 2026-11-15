import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { killApp, launchApp } from './helpers'
import { logLines, MODEL_FOLDER, modelSource, processUnit, REPLAY } from './tutorSetup'

// The tutor loop in the built app, with model replies replayed from a file (no network): process
// a unit, take the diagnostic, see the standings, then learn the first concept through every
// step, with a contest, cited pages, KaTeX, and two kills of the app (one right after an answer
// is submitted, one with a draft typed) that must lose nothing.
//
// Processing the unit needs the local embedding model, copied from FEYNMIND_SMOKE_MODEL_CACHE or
// the development profile; the test is skipped when neither has it.

let userDataDir: string

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'feynmind-e2e-tutor-'))
})

test.afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

test('diagnostic, standing, and a whole lesson that survives two kills', async () => {
  test.setTimeout(360_000)
  const model = modelSource()
  test.skip(model === null, 'The embedding model is not on this machine. Run the app once (or npm run smoke with FEYNMIND_SMOKE_MODEL_CACHE) to download it.')
  cpSync(model as string, join(userDataDir, 'models', MODEL_FOLDER), { recursive: true })
  const replayFile = join(userDataDir, 'replay.json')
  writeFileSync(replayFile, JSON.stringify(REPLAY))
  const env = { FEYNMIND_PROVIDER_REPLAY: replayFile }

  let app = await launchApp(userDataDir, env)
  try {
    let page = await app.firstWindow()
    await processUnit(app, page)
    const afterKnowledge = logLines(replayFile).length

    // Diagnostic: one call writes it; answers are graded here.
    await page.getByRole('button', { name: 'Learn' }).click()
    await expect(page.getByTestId('standing')).toHaveText(['Not assessed', 'Not assessed'])
    await expect(page.getByTestId('tutor-estimate').filter({ hasText: 'Writing the quiz' })).toContainText('about 1 model call')
    // The next lesson's estimate is shown before it makes its first call.
    await expect(page.getByTestId('tutor-estimate').filter({ hasText: 'This lesson' })).toContainText('about 6 model calls')
    await page.getByRole('button', { name: 'Take the diagnostic' }).click()
    await expect(page.getByText('Question 1 of at most 3 · relation')).toBeVisible({ timeout: 30_000 })
    expect(logLines(replayFile).length).toBe(afterKnowledge + 1)
    await page.getByRole('button', { name: /Right answer/ }).click()
    await expect(page.getByText('Question 2 of at most 3 · function')).toBeVisible()
    await page.keyboard.press('0')
    // function was missed, so domain is not asked: the quiz ends.
    await expect(page.getByRole('heading', { name: 'Done.' })).toBeVisible()
    await page.getByRole('button', { name: 'See your path' }).click()
    await expect(page.getByTestId('standing')).toHaveText(['New', 'Not assessed'])
    expect(logLines(replayFile).length).toBe(afterKnowledge + 1)

    // Lesson: the question comes before any explanation.
    await page.getByRole('button', { name: 'Start: relation' }).click()
    await expect(page.getByRole('heading', { name: 'Before we start' })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.explanation')).toHaveCount(0)
    await expect(page.locator('.question .katex').first()).toBeVisible()
    await expect(page.getByTestId('session-total')).toContainText('calls')
    await page.getByLabel('Your answer').fill('WRONG ANSWER, I think it is fine.')
    await page.getByRole('button', { name: 'Submit (Ctrl+Enter)' }).click()
    await expect(page.getByTestId('grade-reason')).toHaveText('You did not say whether it is a function.', { timeout: 30_000 })
    await expect(page.getByTestId('grade')).toContainText('Not yet')
    const before = Number(await page.getByTestId('mastery').getAttribute('data-value'))

    // Contest once: both grades stay visible.
    await page.getByRole('button', { name: 'Contest this grade' }).click()
    await page.getByLabel(/Why is the grade wrong/).fill('I did explain it: the reason is in my answer.')
    await page.getByRole('button', { name: 'Send for a second grading' }).click()
    await expect(page.getByTestId('grade')).toHaveCount(2, { timeout: 30_000 })
    await expect(page.getByTestId('grade').nth(1)).toContainText('Your objection holds')
    await expect(page.getByRole('button', { name: 'Contest this grade' })).toHaveCount(0)
    expect(Number(await page.getByTestId('mastery').getAttribute('data-value'))).toBeGreaterThan(before)

    // The explanation streams in, with KaTeX and a citation that opens the page.
    await page.getByRole('button', { name: 'Show me the explanation' }).click()
    await expect(page.getByRole('button', { name: 'Start practising' })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.explanation .katex-display')).toBeVisible()
    // Fonts are subject to the page's Content-Security-Policy; a blocked font would not load.
    const fontsLoaded = await page.evaluate<boolean>(`document.fonts.ready.then(() => [...document.fonts].some((f) => f.family.includes('KaTeX') && f.status === 'loaded'))`)
    expect(fontsLoaded).toBe(true)
    await page.locator('.explanation button.cite').first().click()
    await expect(page.locator('.lesson-preview figure.preview img')).toBeVisible({ timeout: 30_000 })
    await page.locator('.lesson-preview').getByRole('button', { name: 'Close' }).click()

    // Guided practice: submit, then kill the app before the (delayed) grade arrives.
    await page.getByRole('button', { name: 'Start practising' }).click()
    await expect(page.getByRole('heading', { name: 'Guided practice' })).toBeVisible()
    await expect(page.getByText('Fill in the blanks:')).toBeVisible()
    await page.getByLabel('Your answer').fill('The input 1 has outputs 2 and 3, so it is not a function.')
    await page.getByRole('button', { name: 'Submit (Ctrl+Enter)' }).click()
    await expect(page.getByText('Saved. Grading…')).toBeVisible()
    killApp(app)

    app = await launchApp(userDataDir, env)
    page = await app.firstWindow()
    // The app reopens on the lesson, with the answer kept and graded.
    await expect(page.getByRole('heading', { name: 'Guided practice' })).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('blockquote')).toContainText('The input 1 has outputs 2 and 3')
    await expect(page.getByTestId('grade-reason')).toHaveText('You found the repeated input and said why.', { timeout: 30_000 })

    // Partial practice: type a draft, kill, and find it again.
    await page.getByRole('button', { name: 'Next question' }).click()
    await expect(page.getByRole('heading', { name: 'Practice with a start' })).toBeVisible()
    await page.getByLabel('Your answer').fill('A draft about input 1')
    await expect.poll(() => page.evaluate(() => new Promise((r) => setTimeout(() => r(true), 1500)))).toBe(true)
    killApp(app)
    app = await launchApp(userDataDir, env)
    page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Practice with a start' })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByLabel('Your answer')).toHaveValue('A draft about input 1')
    await page.getByLabel('Your answer').fill('Input 1 has two outputs, so no.')
    await page.getByLabel('Your answer').press('Control+Enter')
    await expect(page.getByTestId('grade-reason')).toHaveText('You found the repeated input and said why.', { timeout: 30_000 })

    // On your own, with the call cap reached: the answer is kept, the lesson offers to raise the
    // cap, and the answer is graded once it is raised. A correct answer masters the concept.
    await page.getByRole('button', { name: 'Next question' }).click()
    await expect(page.getByRole('heading', { name: 'On your own (1)' })).toBeVisible()
    const used = Number(/(\d+) calls/.exec((await page.getByTestId('session-total').textContent()) ?? '')?.[1])
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByLabel('Call cap for this course (empty for none)').fill(String(used))
    await page.getByRole('button', { name: 'Save limits' }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
    await page.getByRole('button', { name: 'Learn' }).click()
    await expect(page.getByRole('heading', { name: 'On your own (1)' })).toBeVisible({ timeout: 30_000 })
    await page.getByLabel('Your answer').fill('No, because 1 maps to both 2 and 3.')
    await page.getByRole('button', { name: 'Submit (Ctrl+Enter)' }).click()
    const cap = page.getByTestId('cap-prompt')
    await expect(cap).toContainText(`used ${used} of its ${used} model calls`, { timeout: 30_000 })
    await expect(page.locator('blockquote')).toContainText('1 maps to both 2 and 3')
    await cap.getByLabel('New cap').fill(String(used + 10))
    await cap.getByRole('button', { name: 'Raise cap and continue' }).click()
    await expect(page.getByText('mastered')).toBeVisible({ timeout: 30_000 })
    await expect(cap).toHaveCount(0)
    await page.getByRole('button', { name: 'Finish' }).click()
    await expect(page.getByRole('heading', { name: 'Mastered.' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next: function' })).toBeVisible()

    // No request was ever sent twice for the same content.
    const tutorLines = logLines(replayFile).slice(afterKnowledge)
    const hashes = tutorLines.map((l) => `${l.keys.join(',')}:${l.hash}`)
    expect(new Set(hashes).size).toBe(hashes.length)
  } finally {
    await app.close().catch(() => killApp(app))
  }
})
