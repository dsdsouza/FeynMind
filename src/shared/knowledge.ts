// Types for the syllabus, knowledge jobs, concepts and usage, shared by the main process and the renderer.

import type { PageRef } from './ingestion'

/** Model usage and caps for one course session. Calls are billed requests; requests include refused ones. */
export interface UsageSummary {
  sessionId: number
  calls: number
  requests: number
  cacheHits: number
  inputTokens: number
  outputTokens: number
  /** At the model's price; null when some model used has no known price. */
  costUsd: number | null
  callCap: number | null
  spendCapUsd: number | null
  model: string | null
  price: { inputPerMillion: number; outputPerMillion: number; source: 'table' | 'user'; checked: string | null } | null
  requestsPerMinute: number
}

export interface UsageLimitsInput {
  sessionId: number
  callCap: number | null
  spendCapUsd: number | null
  requestsPerMinute: number
  /** Dollars per million tokens for the selected model, or null to use the built-in price. */
  price: { input: number; output: number } | null
}

/** The one-time notice before course material is first sent to a provider. */
export interface ConsentState {
  provider: string
  given: boolean
  givenAt: string | null
}

export type EstimatePartKind = 'syllabus-parse' | 'syllabus-map' | 'transcribe' | 'extract' | 'match'

export interface EstimatePart {
  kind: EstimatePartKind
  label: string
  /** New calls (not already cached). */
  calls: number
  /** Calls answered from the cache, which cost nothing. */
  cached: number
  inputTokens: number
  outputTokens: number
  /** True when the number of calls depends on earlier results and is a guess. */
  approximate: boolean
}

export interface JobEstimate {
  model: string
  parts: EstimatePart[]
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  /** Extra calls if replies fail validation and are retried (worst case). */
  maxRetryCalls: number
  /** How many past calls calibrated the token ratios (0 = default ratios). */
  calibrationSamples: number
}

export type JobKind = 'syllabus' | 'unit'
export type JobStatus = 'awaiting-approval' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'

export interface JobUsage {
  calls: number
  requests: number
  cacheHits: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
}

export interface JobSummary {
  id: number
  sessionId: number
  kind: JobKind
  unitId: number | null
  unitTitle: string | null
  syllabusId: number | null
  status: JobStatus
  pauseReason: string | null
  /** When a paused job will try again on its own; null when it waits for the user. */
  resumeAt: string | null
  error: string | null
  estimate: JobEstimate
  actual: JobUsage
  steps: { total: number; done: number; failed: number }
  failures: { label: string; error: string }[]
  createdAt: string
  finishedAt: string | null
}

/** A chapter or section of a material, with every stored section id it was split into. */
export interface TocEntry {
  key: string
  materialId: number
  fileName: string
  chapter: string | null
  section: string | null
  pageStart: PageRef
  pageEnd: PageRef
  sectionIds: number[]
}

export interface DraftUnit {
  title: string
  topics: string[]
  startDate: string | null
  endDate: string | null
  /** Share of the course grade, in percent, when the syllabus gives one for this unit. */
  examWeight: number | null
  /** Readings as the syllabus words them, kept to help the user check the mapping. */
  readings: string[]
  tocKeys: string[]
}

export interface DraftExam {
  title: string
  date: string | null
  weight: number | null
  /** Positions (0-based) in the units list. */
  units: number[]
}

export interface SyllabusDraft {
  units: DraftUnit[]
  exams: DraftExam[]
}

export interface SyllabusState {
  id: number
  sourceName: string
  status: 'awaiting-approval' | 'reading' | 'draft' | 'confirmed'
  /** The model's reading (or the saved version once confirmed), for the user to correct. */
  draft: SyllabusDraft | null
  job: JobSummary | null
  toc: TocEntry[]
}

export interface UnitSummary {
  id: number
  ordinal: number
  title: string
  topics: string[]
  startDate: string | null
  endDate: string | null
  examWeight: number | null
  sections: TocEntry[]
  conceptCount: number
  lastJob: JobSummary | null
}

export interface ConceptPage {
  materialId: number
  fileName: string
  page: PageRef
}

export interface ConceptLink {
  id: number
  name: string
  source: 'extracted' | 'user'
}

export interface RemovedLink {
  id: number
  name: string
  status: 'removed-cycle' | 'removed-user'
  reason: string | null
}

export interface ReviewConcept {
  id: number
  name: string
  definition: string
  edited: boolean
  pages: ConceptPage[]
  prerequisites: ConceptLink[]
  removed: RemovedLink[]
  /** Prerequisite names that matched no concept in the session. */
  unresolved: string[]
}

export interface UnitReview {
  unit: UnitSummary
  /** In learning order: every concept comes after its prerequisites. */
  concepts: ReviewConcept[]
  /** Other concepts in the session, for picking a merge target or a prerequisite. */
  others: { id: number; name: string }[]
}
