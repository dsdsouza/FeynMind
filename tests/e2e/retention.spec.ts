import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { killApp, launchApp } from './helpers'
import { MODEL_FOLDER, modelSource, processUnit, REPLAY } from './tutorSetup'

// Retention in the built app, with model replies replayed (no network) and the app's date moved
// forward between launches with FEYNMIND_CLOCK_OFFSET_DAYS (honoured only by unpackaged builds):
// learn a concept, see its due date; eight days later it is due and comes first; missing it brings
// a short re-teach and brings it back the next day; an exam date set close to today changes what
// is recommended, with the reason shown; progress shows the concept.

let userDataDir: string

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'feynmind-e2e-retention-'))
})

test.afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

const criteria = [
  { id: 'c1', text: 'States the result', points: 2, essential: true },
  { id: 'c2', text: 'Gives the reason', points: 2, essential: true }
]

/** The tutor replies, plus an exam on unit 1, review variants and the re-teach. */
const RETENTION_REPLAY = {
  ...REPLAY,
  rules: [
    { schema: 'text', contains: 'The question they missed', reply: 'You did not say whether it is a function [FIRST_CITE]. A relation is a function when each input has one output, so $\\{(1,2),(1,3)\\}$ is not one.' },
    {
      schema: 'covered',
      contains: 'Questions already asked',
      reply: {
        covered: true,
        questions: [1, 2, 3].map((n) => ({ stem: `review variant ${n}: is $\\{(2,1),(2,5)\\}$ a function?`, referenceAnswer: 'No.', criteria, hint: 'Look at the inputs.', pages: ['FIRST_CITE'] }))
      }
    },
    ...REPLAY.rules.map((r) =>
      r.schema === 'exams'
        ? { ...r, reply: { ...(r.reply as object), exams: [{ title: 'Quiz 1', date: '2027-03-01', weight: 20, units: [0] }] } }
        : r
    )
  ]
}

async function today(page: Page): Promise<{ day: string; due: number }> {
  return page.evaluate(async () => {
    const api = (globalThis as unknown as { feynmind: Record<string, (r?: unknown) => Promise<{ ok: boolean; value: { id: number; day: string; due: number } }>> }).feynmind
    const session = await api['sessions:current']?.()
    const state = await api['reviews:today']?.({ sessionId: session?.value.id })
    return { day: state?.value.day ?? '', due: state?.value.due ?? -1 }
  })
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function answer(page: Page, text: string): Promise<void> {
  await page.getByLabel('Your answer').fill(text)
  await page.getByRole('button', { name: 'Submit (Ctrl+Enter)' }).click()
}

test('learned concepts get due dates, reviews come on the right days, a miss re-teaches, and an exam changes the plan', async () => {
  test.setTimeout(480_000)
  const model = modelSource()
  test.skip(model === null, 'The embedding model is not on this machine. Run the app once (or npm run smoke with FEYNMIND_SMOKE_MODEL_CACHE) to download it.')
  cpSync(model as string, join(userDataDir, 'models', MODEL_FOLDER), { recursive: true })
  const replayFile = join(userDataDir, 'replay.json')
  writeFileSync(replayFile, JSON.stringify(RETENTION_REPLAY))
  const launch = (offset: number) => launchApp(userDataDir, { FEYNMIND_PROVIDER_REPLAY: replayFile, FEYNMIND_CLOCK_OFFSET_DAYS: String(offset) })

  // Day 0: learn relation (right before teaching, so the first review is 8 days later).
  let app = await launch(0)
  const start = { day: '' }
  try {
    const page = await app.firstWindow()
    await processUnit(app, page)
    await page.getByRole('button', { name: 'Learn' }).click()
    await expect(page.getByTestId('nothing-due')).toHaveText('Nothing is due today.')
    start.day = (await today(page)).day
    await page.getByRole('button', { name: 'Start: relation' }).click()
    await expect(page.getByRole('heading', { name: 'Before we start' })).toBeVisible({ timeout: 30_000 })
    await answer(page, 'No: the input 1 has two outputs.')
    await page.getByRole('button', { name: 'Show me the explanation' }).click({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Start practising' }).click({ timeout: 30_000 })
    for (const heading of ['Guided practice', 'Practice with a start', 'On your own (1)']) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible({ timeout: 30_000 })
      await answer(page, 'The input 1 has two outputs, so it is not a function.')
      await expect(page.getByTestId('grade')).toBeVisible({ timeout: 30_000 })
      if (heading !== 'On your own (1)') await page.getByRole('button', { name: 'Next question' }).click()
    }
    await page.getByRole('button', { name: 'Finish' }).click()
    await expect(page.getByRole('heading', { name: 'Mastered.' })).toBeVisible()
    await page.getByRole('button', { name: '← Your path' }).click()
    await page.getByRole('button', { name: 'Show concepts' }).first().click()
    await expect(page.getByRole('listitem', { name: 'relation' }).getByTestId('concept-due')).toContainText('next review')
  } finally {
    await app.close().catch(() => killApp(app))
  }

  // Day 7: not due yet. Day 8: due, and it comes before any new lesson.
  app = await launch(7)
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Learn' }).click()
    expect(await today(page)).toEqual({ day: addDays(start.day, 7), due: 0 })
  } finally {
    await app.close().catch(() => killApp(app))
  }

  app = await launch(8)
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Learn' }).click()
    expect(await today(page)).toEqual({ day: addDays(start.day, 8), due: 1 })
    await expect(page.getByTestId('planned-review')).toHaveText([/relation.*Due today/])
    await expect(page.getByTestId('review-estimate')).toContainText('1 grade')
    await expect(page.getByRole('button', { name: 'Start: function' })).toBeDisabled()

    // The review asks for recall only, without naming the concept; this one is missed.
    await page.getByRole('button', { name: 'Start reviews (1)' }).click()
    await expect(page.getByTestId('review-question')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('review-question')).not.toContainText('relation')
    await expect(page.locator('.scaffold')).toHaveCount(0)
    await answer(page, 'WRONG ANSWER, it is fine.')
    await expect(page.getByTestId('reteach-offer')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('review-feedback')).toContainText('relation')
    await expect(page.getByTestId('review-next-due')).toContainText('Next review')

    // The short re-teach, then a check question.
    await page.getByRole('button', { name: 'Short re-teach' }).click()
    await expect(page.getByTestId('reteach')).toContainText('not say whether it is a function', { timeout: 30_000 })
    await answer(page, 'No, because 1 has two outputs.')
    await expect(page.getByTestId('reteach').getByTestId('grade')).toContainText('Correct', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByTestId('review-summary')).toContainText('Missed')
    await page.getByRole('button', { name: 'Back to Learn' }).click()
    await expect(page.getByTestId('nothing-due')).toContainText('1 reviewed today')
  } finally {
    await app.close().catch(() => killApp(app))
  }

  // Day 9: the missed concept is back the next day. Setting the exam close changes the plan.
  app = await launch(9)
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Learn' }).click()
    const now = await today(page)
    expect(now).toEqual({ day: addDays(start.day, 9), due: 1 })
    await expect(page.getByTestId('planned-review')).toHaveText([/relation.*Missed last time/])
    await expect(page.getByTestId('next-reasons')).toHaveText('Why: Next in the syllabus')
    await expect(page.getByTestId('exam-banner')).toHaveCount(0)

    await page.getByText('Exams', { exact: true }).click()
    await page.getByLabel('Date of Quiz 1').fill(addDays(now.day, 5))
    await page.getByRole('listitem', { name: 'Quiz 1' }).getByRole('button', { name: 'Save' }).click()
    await expect(page.getByTestId('exam-banner')).toContainText('Quiz 1 is in 5 days')
    await expect(page.getByTestId('next-reasons')).toContainText('Quiz 1 in 5 days')
    await expect(page.getByTestId('planned-review')).toHaveText([/relation.*Quiz 1 in 5 days/])

    // Progress shows the concept and its reviews, from local data only.
    await page.getByRole('button', { name: 'Progress' }).click()
    await expect(page.getByTestId('progress-concepts')).toContainText('relation')
    await expect(page.getByTestId('recall-7-days')).toContainText('first review 4 to 13 days after learning')
  } finally {
    await app.close().catch(() => killApp(app))
  }
})
