import { damped, renderPrompt, textTokens, type PromptFile } from '../knowledge'
import type { ModelTask, Role } from '../providers'
import type { ReasoningJudgment } from '../../shared/tutor'
import { allowedCitations, formatPassages, type Passage } from './passages'
import {
  CONTEST_JSON_SCHEMA,
  DIAGNOSTIC_JSON_SCHEMA,
  GRADE_JSON_SCHEMA,
  LESSON_QUESTIONS_JSON_SCHEMA,
  REASONING_CONTEST_JSON_SCHEMA,
  REASONING_GRADE_JSON_SCHEMA,
  REVIEW_QUESTIONS_JSON_SCHEMA,
  parseContest,
  parseDiagnostic,
  parseExplanation,
  parseGrade,
  parseLessonQuestions,
  parseReteach,
  parseReviewQuestions,
  type ContestGrade,
  type Criterion,
  type CriterionResult,
  type DiagnosticQuestion,
  type Explanation,
  type LessonQuestions,
  type ModelGrade,
  type Reteach,
  type ReviewQuestions,
  type Verdict
} from './schemas'

// Builds the model task for each tutor request: the prompt filled in, the key of what the reply
// depends on (for the cache), the token estimate and the check the reply must pass.

export interface TaskContext {
  sessionId: number
  calibration: { inputFactor: number; outputFactor: number; samples: number }
  signal?: AbortSignal
}

type Built<T> = Omit<ModelTask<T>, 'sessionId' | 'jobId' | 'signal' | 'estimate' | 'uncalibratedEstimate'>

function finish<T>(prompt: PromptFile, rendered: string, variable: string, built: Built<T>, ctx: TaskContext): ModelTask<T> {
  const raw = {
    inputTokens: textTokens(prompt.system) + textTokens(rendered),
    outputTokens: Math.round(prompt.outputBase + prompt.outputRatio * textTokens(variable))
  }
  const f = damped(ctx.calibration)
  return {
    ...built,
    sessionId: ctx.sessionId,
    jobId: null,
    estimate: { inputTokens: Math.round(raw.inputTokens * f.input), outputTokens: Math.round(raw.outputTokens * f.output) },
    uncalibratedEstimate: raw,
    ...(ctx.signal ? { signal: ctx.signal } : {})
  }
}

function base(prompt: PromptFile, role: Role, rendered: string): Pick<Built<unknown>, 'role' | 'prompt' | 'system' | 'text' | 'thinking' | 'maxOutputTokens'> {
  return {
    role,
    prompt: { name: prompt.name, version: prompt.version, hash: prompt.hash },
    system: prompt.system,
    text: rendered,
    thinking: prompt.thinking,
    maxOutputTokens: prompt.maxOutputTokens
  }
}

export interface ConceptBrief {
  name: string
  definition: string
  prerequisites: string[]
}

function lessonValues(concept: ConceptBrief, passages: Passage[]): Record<string, string> {
  return {
    concept: concept.name,
    definition: concept.definition,
    prerequisites: concept.prerequisites.length > 0 ? concept.prerequisites.join('; ') : '(none beyond general background)',
    passages: formatPassages(passages)
  }
}

// Diagnostic

export function diagnosticTask(prompt: PromptFile, concepts: (ConceptBrief & { key: string })[], passages: Passage[], ctx: TaskContext): ModelTask<DiagnosticQuestion[]> {
  const conceptText = concepts.map((c) => `${c.key}: ${c.name}: ${c.definition}`).join('\n')
  const values = { concepts: conceptText, passages: formatPassages(passages) }
  const rendered = renderPrompt(prompt, values)
  const allowed = allowedCitations(passages)
  const keys = concepts.map((c) => c.key)
  return finish(
    prompt,
    rendered,
    `${conceptText}\n${values.passages}`,
    {
      ...base(prompt, 'teaching', rendered),
      jsonSchema: DIAGNOSTIC_JSON_SCHEMA,
      contentKey: JSON.stringify(['diagnostic', rendered]),
      parse: (text) => parseDiagnostic(text, keys, allowed)
    },
    ctx
  )
}

// Lesson questions and explanation

export function lessonQuestionsTask(prompt: PromptFile, concept: ConceptBrief, passages: Passage[], ctx: TaskContext, avoid: string[] = []): ModelTask<LessonQuestions> {
  const values = lessonValues(concept, passages)
  // More questions for a concept: only unaided ones, unlike any already asked.
  const extra = avoid.length > 0
  const rendered = renderPrompt(prompt, values) + (extra ? `\n\nWrite only three new "unaided" questions this time, none of them like these:\n${avoid.map((s) => `- ${s}`).join('\n')}` : '')
  const allowed = allowedCitations(passages)
  return finish(
    prompt,
    rendered,
    values['passages'] ?? '',
    {
      ...base(prompt, 'teaching', rendered),
      jsonSchema: LESSON_QUESTIONS_JSON_SCHEMA,
      contentKey: JSON.stringify(['lesson-questions', rendered]),
      parse: (text) => parseLessonQuestions(text, allowed, extra)
    },
    ctx
  )
}

export function explanationTask(prompt: PromptFile, concept: ConceptBrief, passages: Passage[], ctx: TaskContext): ModelTask<Explanation> {
  const values = lessonValues(concept, passages)
  const rendered = renderPrompt(prompt, values)
  const allowed = allowedCitations(passages)
  return finish(
    prompt,
    rendered,
    values['passages'] ?? '',
    { ...base(prompt, 'teaching', rendered), contentKey: JSON.stringify(['explain', rendered]), parse: (text) => parseExplanation(text, allowed) },
    ctx
  )
}

// Reviews

/** Three new review questions from the lesson's passages, unlike every question already asked. */
export function reviewQuestionsTask(prompt: PromptFile, concept: ConceptBrief, passages: Passage[], asked: string[], ctx: TaskContext): ModelTask<ReviewQuestions> {
  const values: Record<string, string> = { ...lessonValues(concept, passages), asked: asked.length > 0 ? asked.map((s) => `- ${s}`).join('\n') : '(none)' }
  const rendered = renderPrompt(prompt, values)
  const allowed = allowedCitations(passages)
  return finish(
    prompt,
    rendered,
    values['passages'] ?? '',
    {
      ...base(prompt, 'teaching', rendered),
      jsonSchema: REVIEW_QUESTIONS_JSON_SCHEMA,
      contentKey: JSON.stringify(['review-questions', rendered]),
      parse: (text) => parseReviewQuestions(text, allowed, asked)
    },
    ctx
  )
}

export interface ReteachInput {
  question: string
  referenceAnswer: string
  answer: string
  reasoning: string
  /** The grader's verdict, reason, feedback and reasoning comment, as text. */
  feedback: string
}

/** A short re-teach after a missed review, streamed, from the lesson's passages. */
export function reteachTask(prompt: PromptFile, concept: ConceptBrief, passages: Passage[], input: ReteachInput, ctx: TaskContext): ModelTask<Reteach> {
  const values = {
    concept: concept.name,
    definition: concept.definition,
    question: input.question,
    reference: input.referenceAnswer,
    answer: input.answer.trim() === '' ? '(no answer: they chose "I don\'t know")' : input.answer,
    reasoning: input.reasoning.trim() === '' ? '(none given)' : input.reasoning,
    feedback: input.feedback,
    passages: formatPassages(passages)
  }
  const rendered = renderPrompt(prompt, values)
  const allowed = allowedCitations(passages)
  return finish(
    prompt,
    rendered,
    `${values.answer}\n${values.reasoning}\n${values.feedback}`,
    { ...base(prompt, 'teaching', rendered), contentKey: JSON.stringify(['reteach', rendered]), parse: (text) => parseReteach(text, allowed) },
    ctx
  )
}

// Grading

export interface GradingInput {
  question: string
  referenceAnswer: string
  criteria: Criterion[]
  passages: Passage[]
  answer: string
  /** The learner's reasoning, '' when none. With reasoning, use the grade-reasoning prompts. */
  reasoning: string
}

/** The prompt that grades this input: reasoning is graded only by the -reasoning variants. */
export function gradingPromptName(kind: 'grade' | 'grade-contest', input: Pick<GradingInput, 'reasoning'>): string {
  return input.reasoning.trim() === '' ? kind : `${kind}-reasoning`
}

const hasReasoning = (input: Pick<GradingInput, 'reasoning'>): boolean => input.reasoning.trim() !== ''

function checkPrompt(prompt: PromptFile, kind: 'grade' | 'grade-contest', input: GradingInput): void {
  const expected = gradingPromptName(kind, input)
  if (prompt.name !== expected) throw new Error(`This answer must be graded with the ${expected} prompt, not ${prompt.name}.`)
}

function criteriaText(criteria: Criterion[]): string {
  return criteria.map((c) => `${c.id} (${c.points} point${c.points === 1 ? '' : 's'}${c.essential ? ', essential' : ''}): ${c.text}`).join('\n')
}

function gradingValues(input: GradingInput): Record<string, string> & { criteria: string; answer: string } {
  const values = {
    question: input.question,
    reference: input.referenceAnswer,
    criteria: criteriaText(input.criteria),
    passages: formatPassages(input.passages),
    answer: input.answer.trim() === '' ? '(no answer)' : input.answer
  }
  // Only the reasoning prompts have a {{reasoning}} slot; without reasoning nothing changes.
  return hasReasoning(input) ? { ...values, reasoning: input.reasoning.trim() } : values
}

/** The learner's own text, for the output estimate. */
const learnerText = (values: Record<string, string>): string => [values['criteria'], values['answer'], values['reasoning']].filter((v) => v !== undefined).join('\n')

export function gradeTask(prompt: PromptFile, input: GradingInput, ctx: TaskContext): ModelTask<ModelGrade> {
  checkPrompt(prompt, 'grade', input)
  const withReasoning = hasReasoning(input)
  const values = gradingValues(input)
  const rendered = renderPrompt(prompt, values)
  const allowed = allowedCitations(input.passages)
  return finish(
    prompt,
    rendered,
    learnerText(values),
    {
      ...base(prompt, 'grading', rendered),
      jsonSchema: withReasoning ? REASONING_GRADE_JSON_SCHEMA : GRADE_JSON_SCHEMA,
      contentKey: JSON.stringify(['grade', rendered]),
      parse: (text) => parseGrade(text, input.criteria, allowed, withReasoning)
    },
    ctx
  )
}

export interface FirstGrade {
  verdict: Verdict
  criteria: CriterionResult[]
  reason: string
  reasoning?: { judgment: ReasoningJudgment; comment: string } | null
}

export function contestTask(prompt: PromptFile, input: GradingInput, first: FirstGrade, objection: string, ctx: TaskContext): ModelTask<ContestGrade> {
  checkPrompt(prompt, 'grade-contest', input)
  const withReasoning = hasReasoning(input)
  const firstText = [
    `Verdict: ${first.verdict}`,
    ...first.criteria.map((c) => `${c.id}: ${c.met}${c.evidence ? ` (evidence: "${c.evidence}")` : ''}`),
    ...(first.reasoning ? [`Reasoning: ${first.reasoning.judgment}${first.reasoning.comment ? ` (${first.reasoning.comment})` : ''}`] : []),
    `Reason given: ${first.reason}`
  ].join('\n')
  const values = { ...gradingValues(input), first: firstText, objection }
  const rendered = renderPrompt(prompt, values)
  const allowed = allowedCitations(input.passages)
  return finish(
    prompt,
    rendered,
    `${learnerText(values)}\n${objection}`,
    {
      ...base(prompt, 'grading', rendered),
      jsonSchema: withReasoning ? REASONING_CONTEST_JSON_SCHEMA : CONTEST_JSON_SCHEMA,
      contentKey: JSON.stringify(['contest', rendered]),
      parse: (text) => parseContest(text, input.criteria, allowed, withReasoning)
    },
    ctx
  )
}
