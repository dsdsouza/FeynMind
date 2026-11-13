import { describe, expect, it } from 'vitest'
import { MATCH_END, MATCH_START } from '../../src/shared/ingestion'
import { ftsQuery, openOn, queryTerms } from '../../src/main/ingestion/search'
import {
  bestSentence,
  locateOnPages,
  longestRun,
  normalizeWord,
  sentences,
  sentencesAround,
  wordingMatch,
  wordTokens
} from '../../src/main/ingestion/wording'

const words = (text: string): string[] => wordTokens(text).map((t) => t.word)
const marked = (text: string): string => text.replaceAll(MATCH_START, '[').replaceAll(MATCH_END, ']')

describe('normalizing words', () => {
  it('writes number words as digits and drops a plural s', () => {
    expect(['Three', 'four', 'transforms', 'vectors', 'class', 'is', 'has'].map(normalizeWord)).toEqual(['3', '4', 'transform', 'vector', 'class', 'is', 'has'])
  })

  it('skips punctuation and brackets but keeps positions', () => {
    const text = 'T transforms (1,1) to (2,2).'
    expect(words(text)).toEqual(['t', 'transform', '1', '1', 'to', '2', '2'])
    const second = wordTokens(text)[1]
    expect(second && text.slice(second.start, second.end)).toBe('transforms')
  })

  it('gives keyword search both spellings of a number', () => {
    expect(queryTerms('the three by 4 matrix')).toEqual(['three', '4', 'matrix', '3', 'four'])
    expect(ftsQuery(['three', '3'])).toBe('"three" OR "3"')
  })
})

describe('the longest run of words in order', () => {
  it('finds the longest stretch both sequences share', () => {
    expect(longestRun(['a', 'b', 'c', 'd'], ['x', 'b', 'c', 'd', 'a', 'b'])).toEqual({ aStart: 1, bStart: 1, length: 3 })
    expect(longestRun(['a'], ['b']).length).toBe(0)
  })
})

describe('matching the query wording', () => {
  const passage =
    'Challenge Problems 34 (Recommended!) Suppose you know that the 3 by 4 matrix A has the vectors = (2, 3, 1, 0) as the only special solution to Ax = 0. (a) What is the rank of A?'

  it('matches a paraphrased exercise despite number words and plurals', () => {
    const match = wordingMatch(wordTokens('suppose you know that the three by four matrix a has the vector s 2, 3, 1, 0.'), passage)
    expect(match).not.toBeNull()
    expect(match && passage.slice(match.start, match.end)).toBe('Suppose you know that the 3 by 4 matrix A has the vectors')
    expect(match?.coverage).toBeCloseTo(0.6)
  })

  it('needs three meaningful words covering half the query', () => {
    // Only stopwords and single letters in common.
    expect(wordingMatch(wordTokens('what is the rank of a nilpotent operator'), passage)).toBeNull()
    // Three words in a row, but under half of a long query.
    expect(wordingMatch(wordTokens('the only special solution compared with eigenvectors of symmetric positive definite matrices'), passage)).toBeNull()
    // A two-word query can never count as a wording match.
    expect(wordingMatch(wordTokens('special solution'), passage)).toBeNull()
  })
})

describe('sentences', () => {
  it('does not split section numbers or decimals', () => {
    const text = 'Problem Set 2.5 1 Find the inverses. Is it .5 or 0.5? Yes!'
    expect(sentences(text).map((s) => text.slice(s.start, s.end))).toEqual(['Problem Set 2.5 1 Find the inverses.', 'Is it .5 or 0.5?', 'Yes!'])
  })

  it('takes the whole sentences around a range', () => {
    const text = 'First one. Second has the match here. Third one.'
    const at = text.indexOf('match')
    const span = sentencesAround(text, { start: at, end: at + 5 })
    expect(text.slice(span.start, span.end)).toBe('Second has the match here.')
  })

  it('trims a very long sentence around the range at word boundaries', () => {
    const text = `${'word '.repeat(100)}MATCH ${'more '.repeat(100)}end.`
    const at = text.indexOf('MATCH')
    const span = sentencesAround(text, { start: at, end: at + 5 })
    expect(span.start).toBeGreaterThan(0)
    expect(span.end).toBeLessThan(text.length)
    expect(text.slice(span.start, span.end)).toMatch(/^word .* more$/)
  })

  it('picks the sentence with the most different query words', () => {
    const text = 'Matrices are tables. The inverse of a product of matrices reverses the order. Inverse again.'
    const span = bestSentence(text, (w) => (['inverse', 'product', 'matri'].find((s) => w.toLowerCase().startsWith(s)) ?? null))
    expect(span && text.slice(span.start, span.end)).toBe('The inverse of a product of matrices reverses the order.')
    expect(bestSentence(text, () => null)).toBeNull()
  })
})

describe('opening a result on the matching sentences', () => {
  const passage = 'So we did not need to divide rows by pivots. Problem Set 2.5 1 Find the inverses (directly or from the 2 by 2 formula) of A, B, C. 2 For these permutation matrices find the inverse.'

  it('opens on the sentence repeating the query, with the wording marked as one phrase', () => {
    const query = 'Find the inverses directly or from the two by 2 formula for AB and C'
    const opened = openOn(passage, queryTerms(query), wordingMatch(wordTokens(query), passage))
    expect(opened.kind).toBe('wording')
    expect(marked(opened.context.before)).toBe('So we did not need to divide rows by pivots.')
    expect(marked(opened.context.focus)).toBe('Problem Set 2.5 1 [Find the inverses (directly or from the 2 by 2 formula]) of A, B, C.')
    expect(marked(opened.context.after)).toBe('2 For these permutation matrices [find] the [inverse].')
    expect(opened.probe).toEqual(['find', 'the', 'inverse', 'directly', 'or', 'from', 'the', '2', 'by', '2', 'formula'])
  })

  it('opens on the sentence with the most query words when the wording does not match', () => {
    const opened = openOn(passage, queryTerms('permutation inverse'), null)
    expect(opened.kind).toBe('words')
    expect(marked(opened.context.focus)).toBe('2 For these [permutation] matrices find the [inverse].')
    expect(opened.context.after).toBe('')
  })

  it('opens at the start of the passage when no word is shared', () => {
    const opened = openOn(passage, queryTerms('eigenvalues'), null)
    expect(opened.kind).toBe('none')
    expect(opened.context.before).toBe('')
    expect(opened.context.focus).toBe('So we did not need to divide rows by pivots.')
  })
})

describe('placing matched words on a page', () => {
  const pages = [
    { index: 101, label: '91', text: '2.5. Inverse Matrices 91 The inverse matrix looks like L itself. So we did not need to divide rows.' },
    { index: 102, label: '92', text: 'Problem Set 2.5 1 Find the inverses (directly or from the 2 by 2 formula) of A, B, C. 92 Chapter 2' }
  ]

  it('finds the page holding the words', () => {
    expect(locateOnPages(words('Find the inverses directly or from the 2 by 2 formula'), pages)).toEqual({ start: pages[1], end: pages[1] })
  })

  it('reports both pages when the words cross a page break', () => {
    expect(locateOnPages(words('we did not need to divide rows Problem Set 2.5 1 Find'), pages)).toEqual({ start: pages[0], end: pages[1] })
  })

  it('places the longest stretch when a running head breaks the words up', () => {
    const broken = [
      { index: 418, label: '408', text: 'Exercise 11 asks about ranges.' },
      { index: 419, label: '409', text: '12 Suppose a linear T transforms (1,1) to (2,2) and (2,0) to (0,0). Find T(v): 409 (a) v = (2,2)' }
    ]
    expect(locateOnPages(words('transforms (1,1) to (2,2) and (2,0) to (0,0). Find T(v): (a) v = (2,2)'), broken)?.start.index).toBe(419)
  })

  it('gives up when the words are not there', () => {
    expect(locateOnPages(words('singular value decomposition'), pages)).toBeNull()
  })
})
