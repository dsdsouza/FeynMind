import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { FIXTURES, killApp, launchApp, stubFilePicker } from './helpers'

// The tutor loop in the built app, with model replies replayed from a file (no network): process
// a unit, take the diagnostic, see the standings, then learn the first concept through every
// step, with a contest, cited pages, KaTeX, and two kills of the app (one right after an answer
// is submitted, one with a draft typed) that must lose nothing.
//
// Processing the unit needs the local embedding model, copied from FEYNMIND_SMOKE_MODEL_CACHE or
// the development profile; the test is skipped when neither has it.

const MODEL_FOLDER = 'bge-small-en-v1.5-ea104dac'

function modelSource(): string | null {
  const candidates = [process.env['FEYNMIND_SMOKE_MODEL_CACHE'], process.env['APPDATA'] && join(process.env['APPDATA'], 'feynmind', 'models')].filter(
    (p): p is string => typeof p === 'string' && p !== ''
  )
  return candidates.map((dir) => join(dir, MODEL_FOLDER)).find((dir) => existsSync(dir)) ?? null
}

const criteria = [
  { id: 'c1', text: 'States the result', points: 2, essential: true },
  { id: 'c2', text: 'Gives the reason', points: 2, essential: true }
]
const question = (kind: string, n = '') => ({
  kind,
  stem: `${kind} question ${n}: is $\\{(1,2),(1,3)\\}$ a function?`,
  referenceAnswer: 'No: the input 1 has two outputs.',
  scaffold: kind === 'guided' ? 'The input ___ has outputs ___ and ___.' : kind === 'partial' ? 'Look at the input 1.' : null,
  criteria,
  pages: ['FIRST_CITE']
})
const yes = { criteria: [{ id: 'c1', met: 'yes', evidence: 'No' }, { id: 'c2', met: 'yes', evidence: 'two outputs' }], feedback: '', pages: ['FIRST_CITE'], outsideSources: false }

const REPLAY = {
  delayMs: 600,
  rules: [
    // Knowledge: one unit of the text fixture, three concepts relation -> function -> domain.
    {
      schema: 'exams',
      reply: {
        units: [
          { title: 'Functions', topics: ['functions'], startDate: null, endDate: null, examWeight: null, readings: ['1.1-1.2'] },
          { title: 'Matrices', topics: ['matrix operations'], startDate: null, endDate: null, examWeight: null, readings: ['9.5'] }
        ],
        exams: []
      }
    },
    { schema: 'units', reply: { units: [{ unit: 0, toc: [] }, { unit: 1, toc: [] }] } },
    { schema: 'blocks', reply: { blocks: [{ fromLine: 0, text: 'Transcribed text.' }] } },
    { schema: 'answers', reply: 'all-different' },
    { schema: 'concepts', contains: 'Section: 1.2', reply: { concepts: [{ name: 'domain', definition: 'The set of inputs of a function.', pages: ['FIRST_PAGE'], prerequisites: ['function'] }] } },
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
    { schema: 'concepts', reply: { concepts: [] } },
    // Tutor.
    { schema: 'covered', reply: { covered: true, questions: [question('opening'), question('guided'), question('partial'), question('unaided', '1'), question('unaided', '2'), question('unaided', '3')] } },
    {
      schema: 'questions',
      reply: {
        questions: ['C1', 'C2', 'C3'].flatMap((concept) =>
          ['probe', 'confirm'].map((purpose) => ({ concept, purpose, stem: `${purpose} question about ${concept}`, choices: ['Wrong A', 'Right answer', 'Wrong B', 'Wrong C'], answer: 1, why: 'Because it is right.', pages: ['FIRST_CITE'] }))
        )
      }
    },
    { schema: 'text', reply: '## Explanation\nA relation is a set of ordered pairs [FIRST_CITE], such as $\\{(x, y)\\}$.\n\n## Worked example\nIs this a function?\n\n$$\n\\frac{1}{2} + \\sqrt{4}\n$$\n\nYes.' },
    { schema: 'assessment', reply: { ...yes, reason: 'You did give the reason.', assessment: 'Your objection holds: the reason is there.', changed: true } },
    { schema: 'reason', contains: 'WRONG ANSWER', reply: { ...yes, criteria: [{ id: 'c1', met: 'no', evidence: '' }, { id: 'c2', met: 'no', evidence: '' }], reason: 'You did not say whether it is a function.' } },
    { schema: 'reason', reply: { ...yes, reason: 'You found the repeated input and said why.' } }
  ]
}

const SYLLABUS = `MATH 120 Precalculus, Fall 2026.
Weeks 1-3: Functions. Read 1.1 Functions and Function Notation and 1.2 Domain and Range.
Week 4: Matrices and matrix operations. Read 9.5.`

let userDataDir: string

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'feynmind-e2e-tutor-'))
})

test.afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

function logLines(file: string): { keys: string[]; hash: string }[] {
  if (!existsSync(`${file}.log`)) return []
  return readFileSync(`${file}.log`, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { keys: string[]; hash: string })
}

/** Imports the text fixture and a syllabus, puts every section in unit 1, and processes it. */
async function processUnit(app: ElectronApplication, page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('combobox').first()).toHaveValue('replay-model', { timeout: 30_000 })
  // The default of 10 requests a minute would make the lesson wait behind the unit's calls.
  await page.getByLabel('Requests per minute').fill('600')
  await page.getByRole('button', { name: 'Save limits' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await page.getByRole('button', { name: 'Materials' }).click()
  await stubFilePicker(app, [join(FIXTURES, 'openstax-precalculus-text.pdf')])
  await page.getByRole('button', { name: 'Add files' }).click()
  await expect(page.getByTestId('material').filter({ hasText: 'openstax-precalculus-text.pdf' }).getByTestId('material-stage')).toHaveText('Ready', { timeout: 120_000 })
  await page.getByRole('button', { name: 'Course' }).click()
  await page.getByLabel('Or paste the syllabus text').fill(SYLLABUS)
  await page.getByRole('button', { name: 'Use pasted text' }).click()
  await page.getByRole('button', { name: 'Approve and run' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'I understand, continue' }).click()
  await expect(page.getByRole('heading', { name: 'Check the syllabus' })).toBeVisible({ timeout: 30_000 })
  const sections = page.getByRole('listitem', { name: 'Unit 1' }).getByLabel('Sections it covers')
  await sections.selectOption(await sections.locator('option').evaluateAll((options) => options.map((o) => o.getAttribute('value') ?? '')))
  await page.getByRole('button', { name: 'Save syllabus' }).click()
  await page.getByRole('button', { name: 'Estimate this unit' }).click()
  await page.getByTestId('estimate').getByRole('button', { name: 'Approve and run' }).click()
  await expect(page.getByRole('button', { name: 'Review concepts' })).toBeVisible({ timeout: 120_000 })
}

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
    await expect(page.getByTestId('tutor-estimate')).toContainText('about 1 model call')
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
    const fontsLoaded = await page.evaluate(async () => {
      await document.fonts.ready
      return [...document.fonts].some((f) => f.family.includes('KaTeX') && f.status === 'loaded')
    })
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

    // On your own: a correct answer masters the concept and unlocks the next one.
    await page.getByRole('button', { name: 'Next question' }).click()
    await expect(page.getByRole('heading', { name: 'On your own (1)' })).toBeVisible()
    await page.getByLabel('Your answer').fill('No, because 1 maps to both 2 and 3.')
    await page.getByRole('button', { name: 'Submit (Ctrl+Enter)' }).click()
    await expect(page.getByText('mastered')).toBeVisible({ timeout: 30_000 })
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
