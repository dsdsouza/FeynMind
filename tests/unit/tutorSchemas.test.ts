import { describe, expect, it } from 'vitest'
import { citationOf, resolveCitation, splitCitations, type SourceRef } from '../../src/shared/citations'
import { probeStatus, type ProbeNode } from '../../src/main/tutor/diagnostic'
import { normalizeCitation, parseContest, parseDiagnostic, parseExplanation, parseGrade, parseLessonQuestions, verdictOf, type Criterion } from '../../src/main/tutor/schemas'

const allowed = new Set(['S1 p. 12', 'S1 p. 13', 'S2 p. A-2'])

const rubric: Criterion[] = [
  { id: 'c1', text: 'States the domain is $x \\ge 2$', points: 2, essential: true },
  { id: 'c2', text: 'Explains the square root needs a non-negative argument', points: 2, essential: true },
  { id: 'c3', text: 'Uses interval notation', points: 1, essential: false }
]

describe('verdict', () => {
  const results = (c1: string, c2: string, c3: string) =>
    [
      { id: 'c1', met: c1, evidence: '' },
      { id: 'c2', met: c2, evidence: '' },
      { id: 'c3', met: c3, evidence: '' }
    ] as { id: string; met: 'yes' | 'partly' | 'no'; evidence: string }[]

  it('is correct only when the score is high and every essential criterion is fully met', () => {
    expect(verdictOf(rubric, results('yes', 'yes', 'yes'))).toEqual({ verdict: 'correct', score: 1 })
    // 4.5 / 5 = 0.9 but an essential criterion is only partly met.
    expect(verdictOf(rubric, results('yes', 'partly', 'yes')).verdict).toBe('partial')
    // A missing optional point still allows correct: 4 / 5 = 0.8 is below 0.85, so partial.
    expect(verdictOf(rubric, results('yes', 'yes', 'no'))).toEqual({ verdict: 'partial', score: 0.8 })
  })

  it('makes a right answer with a wrong reason partly correct, and a wrong answer incorrect', () => {
    expect(verdictOf(rubric, results('yes', 'no', 'yes')).verdict).toBe('partial')
    expect(verdictOf(rubric, results('no', 'no', 'yes'))).toEqual({ verdict: 'incorrect', score: 0.2 })
    expect(verdictOf(rubric, results('no', 'no', 'no')).verdict).toBe('incorrect')
  })

  it('treats a criterion the grader left out as not met', () => {
    expect(verdictOf(rubric, [{ id: 'c1', met: 'yes', evidence: '' }]).verdict).toBe('partial')
  })

  it('caps a right answer with flawed reasoning at partly correct; sound or absent reasoning changes nothing', () => {
    const all = results('yes', 'yes', 'yes')
    expect(verdictOf(rubric, all, 'flawed')).toEqual({ verdict: 'partial', score: 1 })
    expect(verdictOf(rubric, all, 'sound').verdict).toBe('correct')
    expect(verdictOf(rubric, all, 'none').verdict).toBe('correct')
    expect(verdictOf(rubric, all, null).verdict).toBe('correct')
    // Flawed reasoning never raises a grade, and does not lower a wrong answer further.
    expect(verdictOf(rubric, results('no', 'no', 'no'), 'flawed').verdict).toBe('incorrect')
  })
})

describe('reply checks', () => {
  const grade = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      criteria: [
        { id: 'c2', met: 'no', evidence: '' },
        { id: 'c1', met: 'yes', evidence: 'x >= 2' },
        { id: 'c3', met: 'partly', evidence: '' }
      ],
      reason: 'You found the domain but not why.',
      feedback: 'Say why the root needs a non-negative number.',
      pages: ['S1 p. 12', '[S1 p. 12]'],
      outsideSources: false,
      ...over
    })

  it('accepts a grade, orders criteria like the rubric and removes repeated citations', () => {
    const g = parseGrade(grade(), rubric, allowed)
    expect(g.criteria.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
    expect(g.pages).toEqual(['S1 p. 12'])
  })

  it('rejects a grade that cites a page it was not given, skips or invents a criterion', () => {
    expect(() => parseGrade(grade({ pages: ['S3 p. 99'] }), rubric, allowed)).toThrow('not a page of the passages')
    expect(() => parseGrade(grade({ criteria: [{ id: 'c1', met: 'yes', evidence: '' }] }), rubric, allowed)).toThrow('c2 was not graded')
    expect(() =>
      parseGrade(grade({ criteria: [...rubric.map((c) => ({ id: c.id, met: 'yes', evidence: '' })), { id: 'c9', met: 'yes', evidence: '' }] }), rubric, allowed)
    ).toThrow('c9 is not in the rubric')
    expect(() => parseGrade('not json', rubric, allowed)).toThrow('not JSON')
  })

  it('needs a reasoning judgment only when grading with reasoning', () => {
    expect(() => parseGrade(grade(), rubric, allowed, true)).toThrow()
    expect(() => parseGrade(grade({ reasoning: { judgment: 'fine', comment: '' } }), rubric, allowed, true)).toThrow()
    expect(parseGrade(grade({ reasoning: { judgment: 'flawed', comment: 'Step 2 squares a negative.' } }), rubric, allowed, true).reasoning).toEqual({
      judgment: 'flawed',
      comment: 'Step 2 squares a negative.'
    })
    expect(parseGrade(grade(), rubric, allowed).reasoning).toBeUndefined()
    expect(parseContest(grade({ assessment: 'It holds.', changed: true, reasoning: { judgment: 'sound', comment: '' } }), rubric, allowed, true).reasoning?.judgment).toBe('sound')
  })

  it('needs an assessment in a contest grade', () => {
    expect(() => parseContest(grade(), rubric, allowed)).toThrow()
    expect(parseContest(grade({ assessment: 'Your objection holds.', changed: true }), rubric, allowed).changed).toBe(true)
  })

  it('accepts the citation variants models write, and keeps page labels with hyphens', () => {
    expect(normalizeCitation('S2 p.17')).toBe('S2 p. 17')
    expect(normalizeCitation('[S2, p. 17]')).toBe('S2 p. 17')
    expect(normalizeCitation('s2 page 17')).toBe('S2 p. 17')
    expect(normalizeCitation('S2 pp. 17-18')).toBe('S2 p. 17')
    expect(normalizeCitation('S2 p. 17, 18')).toBe('S2 p. 17')
    expect(normalizeCitation('S2 p. A-2')).toBe('S2 p. A-2')
    expect(parseGrade(grade({ pages: ['S1 p.12', 'S1, p. 13'] }), rubric, allowed).pages).toEqual(['S1 p. 12', 'S1 p. 13'])
  })

  it('checks an explanation for both headings and only known citations', () => {
    const variants = '## Explanation:\nInputs [S1, p.12].\n\n### **Worked Example**\nSteps.'
    expect(parseExplanation(variants, allowed).markdown).toContain('[S1 p. 12]')
    const ok = '## Explanation\nThe domain is the set of inputs [S1 p. 12].\n\n## Worked example\nFor $\\sqrt{x-2}$ ...'
    expect(parseExplanation(ok, allowed)).toEqual({ markdown: ok, outsideSources: false })
    expect(() => parseExplanation(ok.replace('[S1 p. 12]', '[S1 p. 40]'), allowed)).toThrow('S1 p. 40')
    expect(() => parseExplanation(ok.replace('[S1 p. 12]', ''), allowed)).toThrow('cites no page')
    expect(() => parseExplanation('## Explanation\nOnly this.', allowed)).toThrow('Worked example')
    const outside = `> Not covered by your materials: what follows is from general knowledge.\n\n${ok.replace('[S1 p. 12]', '')}`
    expect(parseExplanation(outside, allowed).outsideSources).toBe(true)
  })

  const question = (kind: string, over: Record<string, unknown> = {}) => ({
    kind,
    stem: `A ${kind} question`,
    referenceAnswer: 'The answer.',
    scaffold: kind === 'guided' || kind === 'partial' ? 'Step 1: ___' : null,
    criteria: [{ id: 'c1', text: 'Gets it', points: 2, essential: true }],
    pages: ['S1 p. 13'],
    ...over
  })

  it('needs one opening, guided and partial question and three unaided ones, with scaffolds where due', () => {
    const plan = ['unaided', 'opening', 'guided', 'partial', 'unaided', 'unaided'].map((k) => question(k))
    const parsed = parseLessonQuestions(JSON.stringify({ covered: true, questions: plan }), allowed)
    expect(parsed.questions.map((q) => q.kind)).toEqual(['opening', 'guided', 'partial', 'unaided', 'unaided', 'unaided'])
    // Two unaided questions are enough; one is not. Extra opening questions are left out.
    expect(parseLessonQuestions(JSON.stringify({ covered: true, questions: [...plan.slice(1), question('opening', { stem: 'Second opening' })] }), allowed).questions.map((q) => q.kind)).toEqual(['opening', 'guided', 'partial', 'unaided', 'unaided'])
    const oneUnaided = ['opening', 'guided', 'partial', 'unaided'].map((k) => question(k))
    expect(() => parseLessonQuestions(JSON.stringify({ covered: true, questions: oneUnaided }), allowed)).toThrow('expected 3 unaided questions, got 1')
    const noScaffold = plan.map((q) => (q.kind === 'guided' ? { ...q, scaffold: null } : q))
    expect(() => parseLessonQuestions(JSON.stringify({ covered: true, questions: noScaffold }), allowed)).toThrow('no scaffold')
    const extra = ['unaided', 'unaided', 'unaided'].map((k) => question(k))
    expect(parseLessonQuestions(JSON.stringify({ covered: true, questions: extra }), allowed, true).questions).toHaveLength(3)
  })

  it('needs a probe and a confirm question with four different choices per concept', () => {
    const q = (concept: string, purpose: string, over: Record<string, unknown> = {}) => ({
      concept,
      purpose,
      stem: 'Which is right?',
      choices: ['a', 'b', 'c', 'd'],
      answer: 2,
      why: 'Because c.',
      pages: ['S1 p. 12'],
      ...over
    })
    const ok = [q('C1', 'probe'), q('C1', 'confirm'), q('C2', 'confirm'), q('C2', 'probe')]
    expect(parseDiagnostic(JSON.stringify({ questions: ok }), ['C1', 'C2'], allowed).map((x) => `${x.concept}:${x.purpose}`)).toEqual(['C1:probe', 'C1:confirm', 'C2:probe', 'C2:confirm'])
    expect(() => parseDiagnostic(JSON.stringify({ questions: ok.slice(0, 3) }), ['C1', 'C2'], allowed)).toThrow('no probe question for C2')
    expect(() => parseDiagnostic(JSON.stringify({ questions: [q('C1', 'probe', { choices: ['a', 'A', 'c', 'd'] }), q('C1', 'confirm')] }), ['C1'], allowed)).toThrow('repeats a choice')
    expect(() => parseDiagnostic(JSON.stringify({ questions: [q('C1', 'probe', { choices: ['a', 'b', 'c'] }), q('C1', 'confirm')] }), ['C1'], allowed)).toThrow()
  })
})

describe('citations', () => {
  const sources: SourceRef[] = [{ tag: 'S1', materialId: 4, fileName: 'book.pdf', chapter: null, section: null, pages: [{ index: 28, label: '12' }, { index: 29, label: null }] }]

  it('resolves a citation to the material and PDF page, by printed number or PDF page', () => {
    expect(citationOf('S1', { index: 28, label: '12' })).toBe('S1 p. 12')
    expect(resolveCitation(sources, 'S1 p. 12')?.page).toEqual({ index: 28, label: '12' })
    expect(resolveCitation(sources, 'S1 p. 29')?.page).toEqual({ index: 29, label: null })
    expect(resolveCitation(sources, 'S1 p. 28')).toBeNull()
    expect(resolveCitation(sources, 'S2 p. 12')).toBeNull()
  })

  it('splits text around bracketed citations', () => {
    expect(splitCitations('See [S1 p. 12] and [S2 p. A-2].')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'cite', cite: 'S1 p. 12' },
      { kind: 'text', text: ' and ' },
      { kind: 'cite', cite: 'S2 p. A-2' },
      { kind: 'text', text: '.' }
    ])
  })
})

describe('diagnostic selection', () => {
  // relation -> function -> domain -> range;  function -> inverse;  vector (separate)
  const nodes: ProbeNode[] = [
    { id: 1, prerequisites: [] },
    { id: 2, prerequisites: [1] },
    { id: 3, prerequisites: [2] },
    { id: 4, prerequisites: [3] },
    { id: 5, prerequisites: [2] },
    { id: 6, prerequisites: [] }
  ]

  it('starts from prerequisites, with the concept that decides the most', () => {
    expect(probeStatus(nodes, new Map()).next).toBe(1)
  })

  it('stops probing a branch after a miss and marks what depends on it as new', () => {
    const s = probeStatus(nodes, new Map([[1, true], [2, false]]))
    expect([...s.unknown].sort()).toEqual([2, 3, 4, 5])
    expect(s.next).toBe(6)
  })

  it('counts a correct answer for every prerequisite, and ends when nothing is left or the limit is reached', () => {
    const s = probeStatus(nodes, new Map([[1, true], [2, true], [3, true], [4, true], [5, true], [6, false]]))
    expect(s.next).toBeNull()
    expect(probeStatus(nodes, new Map([[1, true]]), 1).next).toBeNull()
    const inferred = probeStatus(nodes, new Map([[1, true], [6, true], [2, true], [4, true]]))
    expect(inferred.known.has(3)).toBe(true)
  })
})
