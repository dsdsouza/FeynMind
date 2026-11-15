import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { FIXTURES, stubFilePicker } from './helpers'

// Shared by the tutor and dictation end-to-end tests: replayed model replies for one unit of the
// text fixture and its lessons, and the steps that process that unit.

export const MODEL_FOLDER = 'bge-small-en-v1.5-ea104dac'

export function modelSource(): string | null {
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

export const REPLAY = {
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
    // Tutor. Answers with reasoning are graded by grade-reasoning, whose reply has a reasoning field.
    {
      schema: 'reasoning',
      reply: {
        ...yes,
        reason: 'You found the repeated input, and your answer is right.',
        reasoning: { judgment: 'flawed', comment: 'You compared painting and mathematics, which does not show why the relation is not a function.' }
      }
    },
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

export const SYLLABUS = `MATH 120 Precalculus, Fall 2026.
Weeks 1-3: Functions. Read 1.1 Functions and Function Notation and 1.2 Domain and Range.
Week 4: Matrices and matrix operations. Read 9.5.`

export function logLines(file: string): { keys: string[]; hash: string }[] {
  if (!existsSync(`${file}.log`)) return []
  return readFileSync(`${file}.log`, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { keys: string[]; hash: string })
}

/** Imports the text fixture and a syllabus, puts every section in unit 1, and processes it. */
export async function processUnit(app: ElectronApplication, page: Page): Promise<void> {
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
