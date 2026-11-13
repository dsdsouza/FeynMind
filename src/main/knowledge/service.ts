import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  ConceptPage,
  ConsentState,
  DraftUnit,
  EstimatePart,
  JobEstimate,
  JobSummary,
  ReviewConcept,
  SyllabusDraft,
  SyllabusState,
  TocEntry,
  UnitReview,
  UnitSummary,
  UsageSummary
} from '../../shared/knowledge'
import type { IngestionReader } from '../ingestion'
import { cacheKeyOf, InvalidOutputError, PauseError, ProviderError, UserFacingError, type KeyValueStore, type ModelTask, type ModelTaskResult, type Role } from '../providers'
import { breakCycles, buildUnitGraph, position } from './build'
import { learningOrder, wouldMakeCycle } from './graph'
import type { PromptLibrary } from './prompts'
import { KnowledgeRepo, type JobRow, type NewStep, type StepRow, type UnitRow } from './repo'
import {
  damped,
  extractionKey,
  extractionTask,
  IMAGE_TOKENS,
  mapEstimateBeforeParse,
  matchTask,
  rawEstimate,
  syllabusMapTask,
  syllabusParseTask,
  textTokens,
  transcriptionKey,
  transcriptionTask,
  EXPECTED_PAIRS_PER_SECTION,
  matchEstimate,
  type MatchPair,
  type TaskContext,
  type TocLine
} from './tasks'

const ROLE: Role = 'ingestion'
const MAX_PASTED_SYLLABUS = 100_000
const EMBED_BATCH = 64
const MAX_NAME = 100
const MAX_DEFINITION = 500

/** What the knowledge module needs from the providers module. */
export interface KnowledgeProviders {
  modelForRole(role: Role): string
  providerName(): string
  run<T>(task: ModelTask<T>): Promise<ModelTaskResult<T>>
  isCached(role: Role, prompt: { name: string; hash: string }, contentKey: string): boolean
  calibration(role: Role, prompt: string): { inputFactor: number; outputFactor: number; samples: number }
  costOf(model: string, tokens: { inputTokens: number; outputTokens: number }): number | null
  costOfTotals(totals: ReturnType<KnowledgeProviders['jobTotals']>): number | null
  jobTotals(jobId: number): { calls: number; requests: number; cacheHits: number; inputTokens: number; outputTokens: number; byModel: { model: string; inputTokens: number; outputTokens: number }[] }
  usageSummary(sessionId: number): UsageSummary
  safeErrorMessage(error: unknown): string
}

/** What the knowledge module needs from the ingestion module. */
export interface KnowledgeIngestion {
  reader: IngestionReader
  readText(path: string): Promise<{ name: string; sha256: string; text: string }>
  renderForVision(materialId: number, pageIndex: number): Promise<Uint8Array>
  rechunkSections(sectionIds: number[]): Promise<{ chunks: number }>
  embedTexts(texts: string[]): Promise<Float32Array[]>
}

export interface KnowledgeServiceOptions {
  db: Database.Database
  providers: KnowledgeProviders
  ingestion: KnowledgeIngestion
  prompts: PromptLibrary
  settings: KeyValueStore
  /** Session caps, to refuse an estimate that cannot fit. */
  limits: (sessionId: number) => { callCap: number | null; spendCapUsd: number | null }
  onJob: (job: JobSummary) => void
  onUsage: (usage: UsageSummary) => void
  now?: () => number
}

/** Raised by a step that cannot finish but should not stop the rest of the job. */
class StepFailed extends Error {}

/**
 * The knowledge module's public service: syllabus import, unit jobs (estimate, approve, run,
 * pause, resume), the review screen's data and its edits. Jobs run one at a time in this
 * process; all their state is in the database, so a job interrupted by closing the app continues
 * at the next start from its first unfinished step, and paid results come from the cache.
 */
export class KnowledgeService {
  readonly repo: KnowledgeRepo
  private loop: Promise<void> | null = null
  private loopAgain = false
  private current: { jobId: number; abort: AbortController } | null = null
  private readonly timers = new Map<number, NodeJS.Timeout>()
  private stopped = false
  private readonly now: () => number

  constructor(private readonly options: KnowledgeServiceOptions) {
    this.repo = new KnowledgeRepo(options.db)
    this.now = options.now ?? (() => Date.now())
  }

  private get reader(): IngestionReader {
    return this.options.ingestion.reader
  }

  /** Resumes jobs that were running when the app closed, and schedules paused ones with a resume time. */
  start(): void {
    for (const job of this.repo.jobsToResume()) {
      if (job.status === 'paused' && job.resumeAt) this.scheduleResume(job.id, job.resumeAt)
    }
    this.kick()
  }

  /** Stops running jobs, waiting briefly for a request in flight so its result is cached. */
  async stop(timeoutMs = 5_000): Promise<void> {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.current?.abort.abort(new Error('The app is closing.'))
    if (this.loop) await Promise.race([this.loop, new Promise((r) => setTimeout(r, timeoutMs))])
  }

  // Consent

  consent(sessionId: number): ConsentState {
    const provider = this.options.providers.providerName()
    const givenAt = this.options.settings.get(consentKey(sessionId, provider))
    return { provider, given: givenAt !== null, givenAt }
  }

  giveConsent(sessionId: number): ConsentState {
    this.options.settings.set(consentKey(sessionId, this.options.providers.providerName()), new Date(this.now()).toISOString())
    return this.consent(sessionId)
  }

  // Syllabus

  async startSyllabusFromFile(sessionId: number, path: string): Promise<SyllabusState> {
    const { name, sha256, text } = await this.options.ingestion.readText(path)
    return this.startSyllabus(sessionId, name, sha256, text)
  }

  startSyllabusFromText(sessionId: number, text: string): SyllabusState {
    const trimmed = text.trim()
    if (trimmed.length < 20) throw new UserFacingError('Paste the whole syllabus.')
    if (trimmed.length > MAX_PASTED_SYLLABUS) throw new UserFacingError(`That is longer than a syllabus (over ${MAX_PASTED_SYLLABUS.toLocaleString('en-US')} characters).`)
    return this.startSyllabus(sessionId, 'Pasted text', createHash('sha256').update(trimmed).digest('hex'), trimmed)
  }

  private startSyllabus(sessionId: number, sourceName: string, sha256: string, text: string): SyllabusState {
    for (const job of this.repo.openJobs(sessionId)) if (job.kind === 'syllabus') this.cancel(job.id)
    const syllabusId = this.repo.createSyllabus({ sessionId, sourceName, sha256, text })
    const model = this.options.providers.modelForRole(ROLE)
    const toc = this.tocLines(sessionId)
    const parse = this.options.prompts.get('syllabus-parse')
    const map = this.options.prompts.get('syllabus-map')
    const parseTokens = this.calibrated(parse.name, rawEstimate(parse, `${parse.template}${text}`, text, 0))
    const parseCached = this.options.providers.isCached(ROLE, parse, JSON.stringify(['syllabus', text]))
    const parts: EstimatePart[] = [part('syllabus-parse', 'Read the syllabus', parseCached ? 0 : 1, parseCached ? 1 : 0, parseCached ? zero : parseTokens, false)]
    if (toc.length > 0) parts.push(part('syllabus-map', 'Match units to book sections', 1, 0, this.calibrated(map.name, mapEstimateBeforeParse(map, text.length, toc)), true))
    const steps: NewStep[] = [{ kind: 'syllabus-parse' }, ...(toc.length > 0 ? [{ kind: 'syllabus-map' as const }] : [])]
    const jobId = this.repo.createJob({ sessionId, kind: 'syllabus', unitId: null, syllabusId, model, estimate: this.estimateOf(model, parts), steps })
    this.emitJob(jobId)
    return this.syllabusState(sessionId) as SyllabusState
  }

  syllabusState(sessionId: number): SyllabusState | null {
    const syllabus = this.repo.latestSyllabus(sessionId)
    if (!syllabus) return null
    const job = this.repo.jobsOfSession(sessionId).find((j) => j.syllabusId === syllabus.id)
    return {
      id: syllabus.id,
      sourceName: syllabus.sourceName,
      status: syllabus.status,
      draft: syllabus.draft,
      job: job ? this.summary(job) : null,
      toc: this.reader.tableOfContents(sessionId)
    }
  }

  /** Saves the user's corrected syllabus. Replaces the session's earlier units. */
  saveSyllabus(syllabusId: number, draft: SyllabusDraft): UnitSummary[] {
    const syllabus = this.repo.getSyllabus(syllabusId)
    if (!syllabus) throw new UserFacingError('That syllabus no longer exists.')
    const toc = new Map(this.reader.tableOfContents(syllabus.sessionId).map((t) => [t.key, t]))
    const clean = validateDraft(draft, new Set(toc.keys()))
    this.repo.confirmSyllabus(syllabusId, clean, (key) => toc.get(key)?.sectionIds ?? [])
    return this.units(syllabus.sessionId)
  }

  units(sessionId: number): UnitSummary[] {
    const toc = this.reader.tableOfContents(sessionId)
    return this.repo.units(sessionId).map((u) => this.unitSummary(u, toc))
  }

  private unitSummary(unit: UnitRow, toc: TocEntry[]): UnitSummary {
    const ids = new Set(this.repo.unitSectionIds(unit.id))
    const last = this.repo.lastJobOfUnit(unit.id)
    return {
      id: unit.id,
      ordinal: unit.ordinal,
      title: unit.title,
      topics: unit.topics,
      startDate: unit.startDate,
      endDate: unit.endDate,
      examWeight: unit.examWeight,
      sections: toc.filter((t) => t.sectionIds.some((s) => ids.has(s))),
      conceptCount: this.repo.conceptCount(unit.id),
      lastJob: last ? this.summary(last) : null
    }
  }

  // Unit jobs

  /** Creates a job for a unit with a fresh estimate, waiting for approval. Replaces an earlier unapproved estimate. */
  estimateUnit(unitId: number): JobSummary {
    const unit = this.repo.getUnit(unitId)
    if (!unit) throw new UserFacingError('That unit no longer exists.')
    for (const job of this.repo.openJobs(unit.sessionId)) {
      if (job.kind === 'unit' && job.unitId === unitId && job.status === 'awaiting-approval') this.repo.setJobStatus(job.id, 'cancelled')
      else if (job.kind === 'unit' && job.unitId === unitId) throw new UserFacingError('This unit already has a job in progress. Finish or cancel it first.')
    }
    const sectionIds = this.repo.unitSectionIds(unitId)
    if (sectionIds.length === 0) throw new UserFacingError('This unit is not matched to any book sections. Edit the syllabus to add its sections.')
    const model = this.options.providers.modelForRole(ROLE)
    const { parts, steps } = this.planUnit(model, sectionIds)
    const jobId = this.repo.createJob({ sessionId: unit.sessionId, kind: 'unit', unitId, syllabusId: null, model, estimate: this.estimateOf(model, parts), steps })
    return this.emitJob(jobId)
  }

  private planUnit(model: string, sectionIds: number[]): { parts: EstimatePart[]; steps: NewStep[] } {
    const providers = this.options.providers
    const transcribe = this.options.prompts.get('page-transcribe')
    const extract = this.options.prompts.get('concept-extract')
    const match = this.options.prompts.get('concept-match')
    const steps: NewStep[] = []

    // Transcription of flagged pages.
    const pending = new Set<string>()
    const t = { calls: 0, cached: 0, inputTokens: 0, outputTokens: 0 }
    const transcribeCal = damped(providers.calibration(ROLE, transcribe.name))
    const flagged = this.reader.flaggedPages(sectionIds)
    for (const { materialId, pageIndex } of flagged) {
      steps.push({ kind: 'transcribe', materialId, pageIndex })
      const page = this.reader.pageForVision(materialId, pageIndex)
      const sha = this.reader.materialSha(materialId)
      if (!page || !sha) continue
      const contentKey = transcriptionKey(sha, page)
      if (this.repo.transcriptKey(materialId, pageIndex) === cacheKeyOf(transcribe, model, contentKey) || providers.isCached(ROLE, transcribe, contentKey)) {
        t.cached++
        continue
      }
      pending.add(`${materialId}:${pageIndex}`)
      const lines = page.lines.map((l, i) => `${i}: ${l.text}`).join('\n')
      const raw = rawEstimate(transcribe, `${transcribe.template}${lines}`, lines, 1)
      t.calls++
      t.inputTokens += Math.round((raw.inputTokens - IMAGE_TOKENS) * transcribeCal.input) + IMAGE_TOKENS
      t.outputTokens += Math.round(raw.outputTokens * transcribeCal.output)
    }
    const rechunk = new Set<number>()
    for (const { materialId, pageIndex } of flagged) for (const id of this.reader.sectionsOnPage(sectionIds, materialId, pageIndex)) rechunk.add(id)
    for (const id of sectionIds) if (rechunk.has(id)) steps.push({ kind: 'rechunk', sectionId: id })

    // Extraction, one call per section with text.
    const e = { calls: 0, cached: 0, inputTokens: 0, outputTokens: 0 }
    let sectionsWithText = 0
    const extractCal = damped(providers.calibration(ROLE, extract.name))
    for (const id of sectionIds) {
      steps.push({ kind: 'extract', sectionId: id })
      const content = this.reader.sectionContent(id)
      if (!content || content.pages.length === 0) continue
      sectionsWithText++
      const willChange = content.pages.some((p) => pending.has(`${content.materialId}:${p.index}`))
      if (!willChange && providers.isCached(ROLE, extract, extractionKey(extract, content))) {
        e.cached++
        continue
      }
      // Pages still to be transcribed will be sent as their transcription, which is longer than the extracted text.
      const textTok = content.pages.reduce((n, p) => n + textTokens(`[page ${p.index}]\n${p.text}`) * (pending.has(`${content.materialId}:${p.index}`) ? transcribe.outputRatio : 1), 0)
      e.calls++
      e.inputTokens += Math.round((textTokens(extract.system) + textTokens(extract.template) + textTok) * extractCal.input)
      e.outputTokens += Math.round((extract.outputBase + extract.outputRatio * textTok) * extractCal.output)
    }
    steps.push({ kind: 'build' })

    // Matching: how many unclear pairs there will be is unknown until the concepts exist.
    const m = matchEstimate(match, sectionsWithText * EXPECTED_PAIRS_PER_SECTION)
    const mTokens = this.calibrated(match.name, m)

    return {
      parts: [
        part('transcribe', 'Transcribe flagged pages', t.calls, t.cached, t, false),
        part('extract', 'Find concepts in each section', e.calls, e.cached, e, false),
        part('match', 'Check unclear duplicates and prerequisites', m.calls, 0, mTokens, true)
      ],
      steps
    }
  }

  /** Starts a job the user approved. The session's consent notice must have been confirmed. */
  approve(jobId: number): JobSummary {
    const job = this.repo.getJob(jobId)
    if (!job) throw new UserFacingError('That job no longer exists.')
    if (job.status !== 'awaiting-approval') throw new UserFacingError('That job has already been approved or cancelled.')
    if (!this.consent(job.sessionId).given) throw new UserFacingError('Confirm the notice about sending course material first.')
    if (this.options.providers.modelForRole(ROLE) !== job.model) throw new UserFacingError('The model was changed after this estimate. Estimate again.')
    const { callCap } = this.options.limits(job.sessionId)
    const used = this.options.providers.usageSummary(job.sessionId).calls
    if (callCap !== null && used + job.estimate.calls > callCap) {
      throw new UserFacingError(`This job needs about ${job.estimate.calls} calls, but the session's cap of ${callCap} leaves ${Math.max(0, callCap - used)}. Raise the cap to approve it.`)
    }
    this.repo.setJobStatus(jobId, 'running')
    this.kick()
    return this.emitJob(jobId)
  }

  pause(jobId: number): JobSummary {
    const job = this.mustJob(jobId)
    if (job.status !== 'running' && job.status !== 'paused') throw new UserFacingError('Only a running job can be paused.')
    this.repo.setJobStatus(jobId, 'paused', { pauseReason: 'Paused by you.' })
    this.clearTimer(jobId)
    if (this.current?.jobId === jobId) this.current.abort.abort(new Error('Paused.'))
    return this.emitJob(jobId)
  }

  resume(jobId: number): JobSummary {
    const job = this.mustJob(jobId)
    if (job.status !== 'paused') throw new UserFacingError('Only a paused job can be resumed.')
    this.repo.setJobStatus(jobId, 'running')
    this.clearTimer(jobId)
    this.kick()
    return this.emitJob(jobId)
  }

  cancel(jobId: number): JobSummary {
    const job = this.mustJob(jobId)
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return this.summary(job)
    this.repo.setJobStatus(jobId, 'cancelled')
    this.clearTimer(jobId)
    if (this.current?.jobId === jobId) this.current.abort.abort(new Error('Cancelled.'))
    if (job.syllabusId !== null) {
      const syllabus = this.repo.getSyllabus(job.syllabusId)
      if (syllabus && syllabus.status !== 'confirmed' && syllabus.draft === null) this.repo.setSyllabusDraft(syllabus.id, null, 'awaiting-approval')
    }
    return this.emitJob(jobId)
  }

  jobs(sessionId: number): JobSummary[] {
    return this.repo.jobsOfSession(sessionId).map((j) => this.summary(j))
  }

  // Running jobs

  private kick(): void {
    if (this.stopped) return
    if (this.loop) {
      this.loopAgain = true
      return
    }
    this.loop = (async () => {
      do {
        this.loopAgain = false
        for (;;) {
          if (this.stopped) return
          const job = this.repo.jobsToResume().find((j) => j.status === 'running')
          if (!job) break
          await this.runJob(job)
        }
      } while (this.loopAgain && !this.stopped)
    })().finally(() => {
      this.loop = null
      // A job approved or resumed while the loop was finishing must not be missed.
      if (this.loopAgain && !this.stopped) this.kick()
    })
  }

  /** Waits until no job is running (for tests). */
  async idle(): Promise<void> {
    while (this.loop) await this.loop
  }

  private async runJob(job: JobRow): Promise<void> {
    const abort = new AbortController()
    this.current = { jobId: job.id, abort }
    try {
      if (this.options.providers.modelForRole(ROLE) !== job.model) {
        throw new PauseError('The model was changed after this job was estimated. Cancel it and estimate the unit again.', 'provider', null)
      }
      for (const step of this.repo.steps(job.id)) {
        if (step.status !== 'pending') continue
        if (abort.signal.aborted) return
        try {
          await this.runStep(job, step, abort.signal)
          this.repo.markStep(step.id, 'done')
        } catch (error) {
          if (abort.signal.aborted) return
          if (error instanceof StepFailed || error instanceof InvalidOutputError || (error instanceof ProviderError && error.kind === 'bad-request')) {
            this.repo.markStep(step.id, 'failed', this.options.providers.safeErrorMessage(error))
          } else {
            throw error
          }
        }
        this.emitJob(job.id)
      }
      if (abort.signal.aborted) return
      this.finishJob(job.id)
    } catch (error) {
      if (abort.signal.aborted) return
      if (error instanceof PauseError) {
        const resumeAt = error.resumeAt?.toISOString() ?? null
        this.repo.setJobStatus(job.id, 'paused', { pauseReason: error.message, resumeAt })
        if (resumeAt) this.scheduleResume(job.id, resumeAt)
      } else {
        this.repo.setJobStatus(job.id, 'paused', { pauseReason: this.options.providers.safeErrorMessage(error) })
      }
      this.emitJob(job.id)
    } finally {
      if (this.current?.jobId === job.id) this.current = null
    }
  }

  private finishJob(jobId: number): void {
    const job = this.mustJob(jobId)
    const steps = this.repo.steps(jobId)
    const finalKind = job.kind === 'unit' ? 'build' : 'syllabus-parse'
    const finalFailed = steps.some((s) => s.kind === finalKind && s.status === 'failed')
    if (finalFailed) this.repo.setJobStatus(jobId, 'failed', { error: steps.find((s) => s.kind === finalKind)?.error ?? null })
    else this.repo.setJobStatus(jobId, 'done')
    if (job.syllabusId !== null && !finalFailed) {
      const syllabus = this.repo.getSyllabus(job.syllabusId)
      if (syllabus && syllabus.status === 'reading') this.repo.setSyllabusDraft(syllabus.id, syllabus.draft, 'draft')
    }
    this.emitJob(jobId)
  }

  private async runStep(job: JobRow, step: StepRow, signal: AbortSignal): Promise<void> {
    const ctx = (prompt: string): TaskContext => ({ sessionId: job.sessionId, jobId: job.id, calibration: this.options.providers.calibration(ROLE, prompt), signal })
    const run = async <T>(task: ModelTask<T>): Promise<T> => {
      const result = await this.options.providers.run(task)
      this.options.onUsage(this.options.providers.usageSummary(job.sessionId))
      return result.value
    }
    switch (step.kind) {
      case 'syllabus-parse': {
        const syllabus = this.repo.getSyllabus(job.syllabusId ?? -1)
        if (!syllabus) throw new StepFailed('The syllabus was removed.')
        this.repo.setSyllabusDraft(syllabus.id, null, 'reading')
        const parsed = await run(syllabusParseTask(this.options.prompts.get('syllabus-parse'), syllabus.text, ctx('syllabus-parse')))
        const draft: SyllabusDraft = {
          units: parsed.units.map((u) => ({ ...u, tocKeys: [] })),
          exams: parsed.exams.map((e) => ({ title: e.title, date: e.date, weight: e.weight, units: e.units }))
        }
        this.repo.setSyllabusDraft(syllabus.id, draft, 'reading')
        return
      }
      case 'syllabus-map': {
        const syllabus = this.repo.getSyllabus(job.syllabusId ?? -1)
        if (!syllabus?.draft) throw new StepFailed('The syllabus could not be read, so there is nothing to match.')
        const toc = this.reader.tableOfContents(job.sessionId)
        const lines = tocLinesOf(toc)
        const mapping = await run(syllabusMapTask(this.options.prompts.get('syllabus-map'), syllabus.draft.units, lines, ctx('syllabus-map')))
        const keyOf = new Map(lines.map((l, i) => [l.id, toc[i]?.key ?? '']))
        const units = syllabus.draft.units.map((u, i) => ({ ...u, tocKeys: (mapping.get(i) ?? []).map((id) => keyOf.get(id) ?? '').filter((k) => k !== '') }))
        this.repo.setSyllabusDraft(syllabus.id, { ...syllabus.draft, units }, 'reading')
        return
      }
      case 'transcribe': {
        const materialId = step.materialId ?? -1
        const pageIndex = step.pageIndex ?? -1
        const page = this.reader.pageForVision(materialId, pageIndex)
        const sha = this.reader.materialSha(materialId)
        if (!page || !sha) throw new StepFailed('The page is no longer in the session.')
        const prompt = this.options.prompts.get('page-transcribe')
        const contentKey = transcriptionKey(sha, page)
        const key = cacheKeyOf(prompt, job.model, contentKey)
        if (this.repo.transcriptKey(materialId, pageIndex) === key) return
        const image = this.options.providers.isCached(ROLE, prompt, contentKey) ? null : await this.options.ingestion.renderForVision(materialId, pageIndex)
        const transcription = await run(transcriptionTask(prompt, page, sha, image, ctx(prompt.name)))
        this.repo.saveTranscript({ sessionId: job.sessionId, materialId, pageIndex, blocks: transcription.blocks, cacheKey: key })
        return
      }
      case 'rechunk':
        await this.options.ingestion.rechunkSections([step.sectionId ?? -1])
        return
      case 'extract': {
        const sectionId = step.sectionId ?? -1
        const content = this.reader.sectionContent(sectionId)
        if (!content) throw new StepFailed('The section is no longer in the session.')
        if (content.pages.length === 0) {
          this.repo.replaceMentions(job.sessionId, sectionId, 'empty', [])
          return
        }
        const prompt = this.options.prompts.get('concept-extract')
        const task = extractionTask(prompt, content, ctx(prompt.name))
        const concepts = await run(task)
        this.repo.replaceMentions(job.sessionId, sectionId, cacheKeyOf(prompt, job.model, task.contentKey), concepts)
        return
      }
      case 'build': {
        const unitId = job.unitId ?? -1
        const prompt = this.options.prompts.get('concept-match')
        await buildUnitGraph(
          {
            repo: this.repo,
            embed: (texts) => this.embed(texts),
            match: (pairs: MatchPair[]) => run(matchTask(prompt, pairs, ctx(prompt.name))),
            materialOf: (sectionId) => this.reader.materialOfSection(sectionId) ?? 0
          },
          job.sessionId,
          unitId,
          this.repo.unitSectionIds(unitId)
        )
        return
      }
      case 'match':
        // Matching happens inside the build step; no job creates this kind of step.
        throw new StepFailed('Unexpected step.')
    }
  }

  private async embed(texts: string[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH) vectors.push(...(await this.options.ingestion.embedTexts(texts.slice(i, i + EMBED_BATCH))))
    return vectors
  }

  private scheduleResume(jobId: number, resumeAt: string): void {
    this.clearTimer(jobId)
    const delay = Math.max(0, Date.parse(resumeAt) - this.now())
    // setTimeout cannot wait longer than about 24 days; a daily quota never needs that long.
    const timer = setTimeout(() => {
      this.timers.delete(jobId)
      const job = this.repo.getJob(jobId)
      if (job?.status === 'paused' && job.resumeAt === resumeAt) {
        this.repo.setJobStatus(jobId, 'running')
        this.emitJob(jobId)
        this.kick()
      }
    }, Math.min(delay, 2 ** 31 - 1))
    this.timers.set(jobId, timer)
  }

  private clearTimer(jobId: number): void {
    const timer = this.timers.get(jobId)
    if (timer) clearTimeout(timer)
    this.timers.delete(jobId)
  }

  // Review

  review(unitId: number): UnitReview {
    const unit = this.repo.getUnit(unitId)
    if (!unit) throw new UserFacingError('That unit no longer exists.')
    const toc = this.reader.tableOfContents(unit.sessionId)
    const all = this.repo.concepts(unit.sessionId)
    const byId = new Map(all.map((c) => [c.id, c]))
    const concepts = this.repo.conceptsOfUnit(unitId)
    const links = this.repo.links(unit.sessionId)
    const active = links.filter((l) => l.status === 'active')
    const pos = (id: number): number => {
      const c = byId.get(id)
      return c ? position(c.firstMaterialId, c.firstPage) : 0
    }
    const order = learningOrder(concepts.map((c) => c.id), active, pos)
    const files = new Map<number, string>()
    const fileName = (materialId: number): string => {
      if (!files.has(materialId)) files.set(materialId, this.reader.fileName(materialId) ?? 'Removed file')
      return files.get(materialId) as string
    }
    const reviewed: ReviewConcept[] = order.map((id) => {
      const c = byId.get(id)
      if (!c) throw new Error(`Concept ${id} is missing.`)
      const pages: ConceptPage[] = this.repo.conceptPages(id).map((p) => ({ materialId: p.materialId, fileName: fileName(p.materialId), page: this.reader.pageRef(p.materialId, p.pageIndex) }))
      const own = links.filter((l) => l.concept === id)
      return {
        id,
        name: c.name,
        definition: c.definition,
        edited: c.edited,
        pages,
        prerequisites: own
          .filter((l) => l.status === 'active')
          .map((l) => ({ id: l.prereq, name: byId.get(l.prereq)?.name ?? '?', source: l.source }))
          .sort((a, b) => pos(a.id) - pos(b.id)),
        removed: own
          .filter((l) => l.status !== 'active')
          .map((l) => ({ id: l.prereq, name: byId.get(l.prereq)?.name ?? '?', status: l.status as 'removed-cycle' | 'removed-user', reason: l.reason })),
        unresolved: this.repo.unresolved(id)
      }
    })
    return {
      unit: this.unitSummary(unit, toc),
      concepts: reviewed,
      others: all.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name))
    }
  }

  renameConcept(unitId: number, conceptId: number, name: string, definition: string | null): UnitReview {
    this.mustConcept(conceptId)
    const cleanName = name.trim()
    if (cleanName === '' || cleanName.length > MAX_NAME) throw new UserFacingError(`A name needs 1 to ${MAX_NAME} characters.`)
    const cleanDefinition = definition === null ? null : definition.trim()
    if (cleanDefinition !== null && (cleanDefinition === '' || cleanDefinition.length > MAX_DEFINITION)) {
      throw new UserFacingError(`A definition needs 1 to ${MAX_DEFINITION} characters.`)
    }
    this.repo.renameConcept(conceptId, cleanName, cleanDefinition)
    return this.review(unitId)
  }

  mergeConcepts(unitId: number, fromId: number, intoId: number): UnitReview {
    const from = this.mustConcept(fromId)
    const into = this.mustConcept(intoId)
    if (from.id === into.id) throw new UserFacingError('Choose a different concept to merge into.')
    if (from.sessionId !== into.sessionId) throw new UserFacingError('Those concepts are in different sessions.')
    this.repo.mergeConcepts(fromId, intoId)
    // Merging can join two halves of a loop.
    breakCycles(this.repo, into.sessionId)
    return this.review(unitId)
  }

  deleteConcept(unitId: number, conceptId: number): UnitReview {
    this.mustConcept(conceptId)
    this.repo.deleteConcept(conceptId)
    return this.review(unitId)
  }

  /** Adds (or restores) "concept needs prereq". Refused if it would make a loop. */
  linkConcepts(unitId: number, conceptId: number, prereqId: number): UnitReview {
    const concept = this.mustConcept(conceptId)
    const prereq = this.mustConcept(prereqId)
    if (concept.sessionId !== prereq.sessionId) throw new UserFacingError('Those concepts are in different sessions.')
    const others = this.repo.activeEdges(concept.sessionId).filter((e) => !(e.concept === conceptId && e.prereq === prereqId))
    if (wouldMakeCycle(others, conceptId, prereqId)) {
      throw new UserFacingError(`"${prereq.name}" already depends on "${concept.name}", so it cannot also be its prerequisite.`)
    }
    this.repo.setLink(conceptId, prereqId, 'user', 'active')
    return this.review(unitId)
  }

  unlinkConcepts(unitId: number, conceptId: number, prereqId: number): UnitReview {
    const link = this.repo.getLink(conceptId, prereqId)
    if (!link) throw new UserFacingError('Those concepts are not linked.')
    this.repo.setLink(conceptId, prereqId, link.source, 'removed-user')
    return this.review(unitId)
  }

  // Helpers

  private mustJob(id: number): JobRow {
    const job = this.repo.getJob(id)
    if (!job) throw new UserFacingError('That job no longer exists.')
    return job
  }

  private mustConcept(id: number): NonNullable<ReturnType<KnowledgeRepo['getConcept']>> {
    const concept = this.repo.getConcept(id)
    if (!concept) throw new UserFacingError('That concept no longer exists.')
    return concept
  }

  private calibrated(prompt: string, raw: { inputTokens: number; outputTokens: number }): { inputTokens: number; outputTokens: number } {
    const f = damped(this.options.providers.calibration(ROLE, prompt))
    return { inputTokens: Math.round(raw.inputTokens * f.input), outputTokens: Math.round(raw.outputTokens * f.output) }
  }

  private estimateOf(model: string, parts: EstimatePart[]): JobEstimate {
    const inputTokens = parts.reduce((n, p) => n + p.inputTokens, 0)
    const outputTokens = parts.reduce((n, p) => n + p.outputTokens, 0)
    const calls = parts.reduce((n, p) => n + p.calls, 0)
    const samples = ['page-transcribe', 'concept-extract', 'concept-match', 'syllabus-parse', 'syllabus-map'].reduce(
      (n, p) => n + this.options.providers.calibration(ROLE, p).samples,
      0
    )
    return {
      model,
      parts,
      calls,
      inputTokens,
      outputTokens,
      costUsd: this.options.providers.costOf(model, { inputTokens, outputTokens }),
      maxRetryCalls: calls * 2,
      calibrationSamples: samples
    }
  }

  private tocLines(sessionId: number): TocLine[] {
    return tocLinesOf(this.reader.tableOfContents(sessionId))
  }

  summary(job: JobRow): JobSummary {
    const totals = this.options.providers.jobTotals(job.id)
    const steps = this.repo.steps(job.id)
    const unit = job.unitId !== null ? this.repo.getUnit(job.unitId) : undefined
    return {
      id: job.id,
      sessionId: job.sessionId,
      kind: job.kind,
      unitId: job.unitId,
      unitTitle: unit?.title ?? null,
      syllabusId: job.syllabusId,
      status: job.status,
      pauseReason: job.pauseReason,
      resumeAt: job.resumeAt,
      error: job.error,
      estimate: job.estimate,
      actual: {
        calls: totals.calls,
        requests: totals.requests,
        cacheHits: totals.cacheHits,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        costUsd: this.options.providers.costOfTotals(totals)
      },
      steps: { total: steps.length, done: steps.filter((s) => s.status === 'done').length, failed: steps.filter((s) => s.status === 'failed').length },
      failures: steps.filter((s) => s.status === 'failed').map((s) => ({ label: this.stepLabel(s), error: s.error ?? '' })),
      createdAt: job.createdAt,
      finishedAt: job.finishedAt
    }
  }

  private stepLabel(step: StepRow): string {
    switch (step.kind) {
      case 'transcribe':
        return `Transcribe page ${this.reader.pageRef(step.materialId ?? 0, step.pageIndex ?? 0).label ?? step.pageIndex} of ${this.reader.fileName(step.materialId ?? 0) ?? 'a removed file'}`
      case 'rechunk':
      case 'extract': {
        const content = this.reader.sectionContent(step.sectionId ?? 0)
        const name = content ? (content.section ?? content.chapter ?? 'untitled section') : 'a removed section'
        return `${step.kind === 'extract' ? 'Find concepts in' : 'Update search for'} ${name}`
      }
      case 'build':
        return 'Build the concept graph'
      case 'syllabus-parse':
        return 'Read the syllabus'
      case 'syllabus-map':
        return 'Match units to book sections'
      case 'match':
        return 'Check duplicates'
    }
  }

  private emitJob(jobId: number): JobSummary {
    const summary = this.summary(this.mustJob(jobId))
    this.options.onJob(summary)
    this.options.onUsage(this.options.providers.usageSummary(summary.sessionId))
    return summary
  }
}

const zero = { inputTokens: 0, outputTokens: 0 }

function part(kind: EstimatePart['kind'], label: string, calls: number, cached: number, tokens: { inputTokens: number; outputTokens: number }, approximate: boolean): EstimatePart {
  return { kind, label, calls, cached, inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens, approximate }
}

function consentKey(sessionId: number, provider: string): string {
  return `session.${sessionId}.consent.${provider.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

function tocLinesOf(toc: TocEntry[]): TocLine[] {
  return toc.map((t, i) => ({
    id: `T${i + 1}`,
    text: [t.fileName, t.chapter, t.section].filter((p) => p).join(' | ') + ` | pages ${t.pageStart.label ?? t.pageStart.index}-${t.pageEnd.label ?? t.pageEnd.index}`
  }))
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

function validateDraft(draft: SyllabusDraft, tocKeys: Set<string>): SyllabusDraft {
  if (!Array.isArray(draft.units) || draft.units.length === 0) throw new UserFacingError('Keep at least one unit.')
  if (draft.units.length > 80) throw new UserFacingError('A syllabus can have at most 80 units.')
  const date = (value: unknown, what: string): string | null => {
    if (value === null || value === '') return null
    if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new UserFacingError(`${what} must be a date (YYYY-MM-DD) or empty.`)
    return value
  }
  const weight = (value: unknown, what: string): number | null => {
    if (value === null) return null
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new UserFacingError(`${what} must be a percentage from 0 to 100, or empty.`)
    return value
  }
  const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  const units: DraftUnit[] = draft.units.map((u, i) => {
    const title = text(u.title, 200)
    if (title === '') throw new UserFacingError(`Unit ${i + 1} needs a title.`)
    const keys = Array.isArray(u.tocKeys) ? u.tocKeys.filter((k): k is string => typeof k === 'string') : []
    const unknown = keys.find((k) => !tocKeys.has(k))
    if (unknown) throw new UserFacingError(`Unit ${i + 1} refers to a section that is no longer in the session. Pick its sections again.`)
    const startDate = date(u.startDate, `The start date of unit ${i + 1}`)
    const endDate = date(u.endDate, `The end date of unit ${i + 1}`)
    if (startDate && endDate && endDate < startDate) throw new UserFacingError(`Unit ${i + 1} ends before it starts.`)
    return {
      title,
      topics: (Array.isArray(u.topics) ? u.topics : []).map((t) => text(t, 300)).filter((t) => t !== ''),
      startDate,
      endDate,
      examWeight: weight(u.examWeight, `The exam weight of unit ${i + 1}`),
      readings: (Array.isArray(u.readings) ? u.readings : []).map((t) => text(t, 300)).filter((t) => t !== ''),
      tocKeys: [...new Set(keys)]
    }
  })
  const exams = (Array.isArray(draft.exams) ? draft.exams : []).map((e, i) => {
    const title = text(e.title, 200)
    if (title === '') throw new UserFacingError(`Exam ${i + 1} needs a title.`)
    return {
      title,
      date: date(e.date, `The date of exam ${i + 1}`),
      weight: weight(e.weight, `The weight of exam ${i + 1}`),
      units: (Array.isArray(e.units) ? e.units : []).filter((u) => Number.isInteger(u) && u >= 0 && u < units.length)
    }
  })
  return { units, exams }
}
