import { describe, expect, it } from 'vitest'
import { insertTranscript } from '../../src/shared/dictation'

describe('inserting dictated text', () => {
  it('fills an empty field', () => {
    expect(insertTranscript('', 0, 0, ' The domain is x ≥ 3. ')).toEqual({ value: 'The domain is x ≥ 3.', cursor: 20 })
  })

  it('adds a space after earlier text and before later text', () => {
    expect(insertTranscript('First.Then done', 6, 6, 'I squared both sides.')).toEqual({ value: 'First. I squared both sides. Then done', cursor: 28 })
  })

  it('does not double spaces or put one before punctuation', () => {
    expect(insertTranscript('Start .', 6, 6, 'middle')).toEqual({ value: 'Start middle.', cursor: 12 })
  })

  it('replaces a selection', () => {
    expect(insertTranscript('x is wrong here', 5, 10, 'three')).toEqual({ value: 'x is three here', cursor: 10 })
  })

  it('leaves the field alone when nothing was heard', () => {
    expect(insertTranscript('keep', 2, 2, '  ')).toEqual({ value: 'keep', cursor: 2 })
  })
})
