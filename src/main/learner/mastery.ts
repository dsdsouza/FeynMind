// The mastery model: Bayesian Knowledge Tracing. Each concept has a probability that the learner
// knows it. Every answer updates it by Bayes' rule (a known concept is answered wrongly with the
// slip probability; an unknown one is answered rightly with the guess probability), and an
// answer given while being taught adds a chance of having learned it. Diagnostic answers measure
// without teaching, so they add no learning step.

/** The kinds of question an answer can come from. */
export type QuestionKind = 'diagnostic' | 'opening' | 'guided' | 'partial' | 'unaided'

export const MASTERY = {
  /** Before any evidence. */
  prior: 0.2,
  /** Chance of learning the concept from one taught step. */
  learn: 0.15,
  /** Chance a learner who knows the concept still answers wrongly. */
  slip: 0.1,
  /**
   * Chance a learner who does not know the concept answers rightly. Four choices give 0.25 for the
   * multiple-choice diagnostic; a guided question gives away part of the answer.
   */
  guess: { diagnostic: 0.25, opening: 0.15, guided: 0.3, partial: 0.2, unaided: 0.15 } satisfies Record<QuestionKind, number>,
  /** Mastered at or above this, together with a correct unaided answer in the lesson (see isMastered). */
  mastered: 0.95,
  known: 0.6,
  shaky: 0.3,
  /** After the opening question, a lesson offers to skip to the unaided question at or above this. */
  fastTrack: 0.9,
  /** A confirmed "I know this unit" raises each of its concepts to at least this. */
  overrideKnown: 0.9
} as const

export type Evidence =
  /** An answer with its score: 1 correct, 0.5 partly correct, 0 wrong or skipped. */
  | { kind: 'answer'; question: QuestionKind; score: number }
  /** A correct diagnostic answer on a concept that depends on this one counts as a correct diagnostic answer here. */
  | { kind: 'inferred-known' }
  /** A missed prerequisite: this concept was not asked about. It counts for the standing but does not move the estimate. */
  | { kind: 'inferred-new' }
  /** The learner's correction: raise to at least, or lower to at most, `value`. */
  | { kind: 'override'; direction: 'known' | 'new'; value: number }

function posterior(p: number, correct: boolean, guess: number): number {
  const slip = MASTERY.slip
  return correct ? (p * (1 - slip)) / (p * (1 - slip) + (1 - p) * guess) : (p * slip) / (p * slip + (1 - p) * (1 - guess))
}

/** The estimate after one piece of evidence. A partly correct answer counts as half of each outcome. */
export function update(p: number, evidence: Evidence): number {
  switch (evidence.kind) {
    case 'answer': {
      const guess = MASTERY.guess[evidence.question]
      const score = Math.min(1, Math.max(0, evidence.score))
      const after = score * posterior(p, true, guess) + (1 - score) * posterior(p, false, guess)
      return evidence.question === 'diagnostic' ? after : after + (1 - after) * MASTERY.learn
    }
    case 'inferred-known':
      return posterior(p, true, MASTERY.guess.diagnostic)
    case 'inferred-new':
      return p
    case 'override':
      return evidence.direction === 'known' ? Math.max(p, evidence.value) : Math.min(p, evidence.value)
  }
}

/** The estimate after all of a concept's evidence, in order. */
export function replay(evidence: Evidence[]): number {
  return evidence.reduce(update, MASTERY.prior)
}

/** Score of a verdict, for the model. */
export function scoreOf(verdict: 'correct' | 'partial' | 'incorrect'): number {
  return verdict === 'correct' ? 1 : verdict === 'partial' ? 0.5 : 0
}

/**
 * Mastered: the estimate is at the threshold, the learner has answered at least one unaided
 * question of the lesson correctly, and the last answer in the lesson was correct. The diagnostic
 * or the opening question alone never makes a concept mastered.
 */
export function isMastered(p: number, lesson: { unaidedCorrect: boolean; lastVerdict: 'correct' | 'partial' | 'incorrect' | null }): boolean {
  return p >= MASTERY.mastered && lesson.unaidedCorrect && lesson.lastVerdict === 'correct'
}

export type Band = 'mastered' | 'known' | 'shaky' | 'new'

export function bandOf(p: number, mastered: boolean): Band {
  if (mastered) return 'mastered'
  if (p >= MASTERY.known) return 'known'
  if (p >= MASTERY.shaky) return 'shaky'
  return 'new'
}

export type Standing = 'known' | 'shaky' | 'new' | 'not-assessed'

/**
 * A unit's standing from the bands of its concepts that have any evidence: known when at least
 * 80% are known or mastered, new when at least 60% are new, otherwise shaky. Not assessed when no
 * concept has evidence (including a unit that has not been processed).
 */
export function unitStanding(bands: (Band | null)[]): Standing {
  const assessed = bands.filter((b): b is Band => b !== null)
  if (assessed.length === 0) return 'not-assessed'
  const known = assessed.filter((b) => b === 'known' || b === 'mastered').length / assessed.length
  const fresh = assessed.filter((b) => b === 'new').length / assessed.length
  if (known >= 0.8) return 'known'
  if (fresh >= 0.6) return 'new'
  return 'shaky'
}
