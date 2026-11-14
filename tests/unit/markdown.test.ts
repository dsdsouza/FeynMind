import { describe, expect, it } from 'vitest'
import { linkCitations, normalizeMath } from '../../src/shared/markdown'

describe('tutor text preparation', () => {
  it('rewrites math delimiters the way remark-math reads them', () => {
    expect(normalizeMath(String.raw`so \(x^2\) and`)).toBe('so $x^2$ and')
    expect(normalizeMath(String.raw`see \[\frac{a}{b}\] here`)).toBe('see \n$$\n\\frac{a}{b}\n$$\n here')
    expect(normalizeMath('$$x + 1$$')).toBe('$$\nx + 1\n$$')
    // $$ inside a sentence stays where it is.
    expect(normalizeMath('a $$x$$ b')).toBe('a $$x$$ b')
  })

  it('links citations but leaves existing links and other brackets alone', () => {
    expect(linkCitations('inputs [S1 p. 12].')).toBe('inputs [S1 p. 12](#cite-S1%20p.%2012).')
    expect(linkCitations('[x](y) and [1, 2]')).toBe('[x](y) and [1, 2]')
  })
})
