// The contract between the main process and the renderer.
// Every channel is listed here with its request and response types.
// The renderer only ever sees these types; it never sees an API key.

import type {
  AddMaterialsResult,
  MaterialSummary,
  ModelStatus,
  PageIssue,
  SearchResponse,
  Session,
  WorkerStatus
} from './ingestion'
import type { DevClockState, ProgressView, ReviewStreamEvent, SittingView, TodayState } from './reviews'
import type {
  ConsentState,
  ExamInfo,
  JobSummary,
  SyllabusDraft,
  SyllabusState,
  UnitReview,
  UnitSummary,
  UsageLimitsInput,
  UsageSummary
} from './knowledge'
import type { DictationStatus, SpeechModelId, SpeedCheckResult } from './dictation'
import type { DiagnosticState, LessonView, PathState, StreamEvent } from './tutor'

export type ProviderId = 'gemini'

export interface ModelInfo {
  /** The id passed to generation calls, e.g. "gemini-2.5-flash-lite". */
  id: string
  displayName: string
  description: string
  inputTokenLimit: number | null
  outputTokenLimit: number | null
}

/** Where the active key came from. The key itself never crosses IPC. */
export type KeySource = 'stored' | 'env' | 'none'

export interface ProviderSettingsState {
  provider: ProviderId
  keySource: KeySource
  /** False when the operating system cannot encrypt secrets (e.g. Linux without a keyring). */
  canStoreKey: boolean
  selectedModel: string | null
}

export interface TestResult {
  model: string
  reply: string
  elapsedMs: number
}

/** Every IPC response is either a value or a user-safe error message. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface IpcContract {
  'settings:getState': { request: undefined; response: ProviderSettingsState }
  'settings:saveKey': { request: { apiKey: string }; response: ProviderSettingsState }
  'settings:clearKey': { request: undefined; response: ProviderSettingsState }
  'settings:selectModel': { request: { modelId: string }; response: ProviderSettingsState }
  'provider:listModels': { request: undefined; response: ModelInfo[] }
  'provider:test': { request: undefined; response: TestResult }
  'sessions:current': { request: undefined; response: Session }
  'materials:list': { request: { sessionId: number }; response: MaterialSummary[] }
  /** Opens a file picker in the main process; null when the user cancels. */
  'materials:add': { request: { sessionId: number }; response: AddMaterialsResult | null }
  'materials:issues': { request: { materialId: number }; response: PageIssue[] }
  /** A page rendered as a PNG data URL, or null when the file cannot be rendered (slides). */
  'materials:renderPage': { request: { materialId: number; pageIndex: number }; response: string | null }
  'search:query': { request: { sessionId: number; query: string }; response: SearchResponse }
  'models:status': { request: undefined; response: ModelStatus }
  'models:retry': { request: undefined; response: ModelStatus }
  'ingestion:status': { request: undefined; response: WorkerStatus }
  'consent:get': { request: { sessionId: number }; response: ConsentState }
  'consent:give': { request: { sessionId: number }; response: ConsentState }
  'usage:get': { request: { sessionId: number }; response: UsageSummary }
  'usage:setLimits': { request: UsageLimitsInput; response: UsageSummary }
  'syllabus:get': { request: { sessionId: number }; response: SyllabusState | null }
  /** Opens a file picker for a syllabus PDF; null when the user cancels. */
  'syllabus:importFile': { request: { sessionId: number }; response: SyllabusState | null }
  'syllabus:importText': { request: { sessionId: number; text: string }; response: SyllabusState }
  'syllabus:save': { request: { syllabusId: number; draft: SyllabusDraft }; response: UnitSummary[] }
  'units:list': { request: { sessionId: number }; response: UnitSummary[] }
  'knowledge:estimateUnit': { request: { unitId: number }; response: JobSummary }
  'knowledge:approve': { request: { jobId: number }; response: JobSummary }
  'knowledge:pause': { request: { jobId: number }; response: JobSummary }
  'knowledge:resume': { request: { jobId: number }; response: JobSummary }
  'knowledge:cancel': { request: { jobId: number }; response: JobSummary }
  'knowledge:jobs': { request: { sessionId: number }; response: JobSummary[] }
  'concepts:review': { request: { unitId: number }; response: UnitReview }
  'concepts:rename': { request: { unitId: number; conceptId: number; name: string; definition: string | null }; response: UnitReview }
  'concepts:merge': { request: { unitId: number; fromId: number; intoId: number }; response: UnitReview }
  'concepts:delete': { request: { unitId: number; conceptId: number }; response: UnitReview }
  'concepts:link': { request: { unitId: number; conceptId: number; prereqId: number }; response: UnitReview }
  'concepts:unlink': { request: { unitId: number; conceptId: number; prereqId: number }; response: UnitReview }
  'tutor:path': { request: { sessionId: number }; response: PathState }
  /** Writes the diagnostic's questions if needed (model calls), then starts it; or returns the one in progress. */
  'diagnostic:start': { request: { sessionId: number }; response: DiagnosticState }
  'diagnostic:state': { request: { diagnosticId: number }; response: DiagnosticState }
  /** choice null means "I don't know". */
  'diagnostic:answer': { request: { diagnosticId: number; questionId: number; choice: number | null }; response: DiagnosticState }
  'standing:claimKnown': { request: { sessionId: number; unitId: number }; response: DiagnosticState }
  'standing:markNew': { request: { sessionId: number; unitId: number }; response: PathState }
  'lesson:open': { request: { sessionId: number; conceptId: number }; response: LessonView }
  'lesson:current': { request: { sessionId: number }; response: LessonView | null }
  'lesson:answer': { request: { lessonId: number; questionId: number; answer: string; skipped: boolean; reasoning?: string }; response: LessonView }
  'lesson:continue': { request: { lessonId: number; fastTrack: boolean }; response: LessonView }
  'lesson:contest': { request: { attemptId: number; objection: string }; response: LessonView }
  'lesson:draft': { request: { lessonId: number; field: 'answer' | 'reasoning'; text: string }; response: null }
  'lesson:more': { request: { lessonId: number }; response: LessonView }
  'lesson:retry': { request: { lessonId: number }; response: LessonView }
  /** Answers the question from an earlier concept mixed into a lesson. */
  'lesson:interleaveAnswer': { request: { lessonId: number; itemId: number; answer: string; skipped: boolean; reasoning?: string }; response: LessonView }
  /** What is due today, the plan for a sitting and its estimate. Local only: works offline. */
  'reviews:today': { request: { sessionId: number }; response: TodayState }
  /** Starts today's sitting (writing new review questions where needed), or returns the one in progress. */
  'reviews:start': { request: { sessionId: number }; response: SittingView }
  'reviews:current': { request: { sessionId: number }; response: SittingView | null }
  /** The learner sees this review's question now (its shown time). */
  'reviews:shown': { request: { itemId: number }; response: null }
  'reviews:answer': { request: { itemId: number; answer: string; skipped: boolean; reasoning?: string }; response: SittingView }
  /** Shows the hint; asking for it counts as help in the rating. */
  'reviews:hint': { request: { itemId: number }; response: SittingView }
  'reviews:draft': { request: { itemId: number; field: 'answer' | 'reasoning'; text: string }; response: null }
  /** Contests a review or re-teach grade (or one mixed into a lesson: the lesson then updates by event). */
  'reviews:contest': { request: { attemptId: number; objection: string }; response: SittingView | null }
  /** Starts the short re-teach after a missed review (one call, streamed as reviews:stream). */
  'reviews:reteach': { request: { itemId: number }; response: SittingView }
  'reviews:reteachAnswer': { request: { itemId: number; answer: string; skipped: boolean; reasoning?: string }; response: SittingView }
  /** Lets new lessons start today without finishing the reviews; they stay due. */
  'reviews:skipToday': { request: { sessionId: number }; response: TodayState }
  'reviews:setLimit': { request: { sessionId: number; limit: number }; response: TodayState }
  /** Delayed recall, reviews per day, the coming due reviews and every concept's memory. Local only. */
  'reviews:progress': { request: { sessionId: number }; response: ProgressView }
  'exams:list': { request: { sessionId: number }; response: ExamInfo[] }
  /** Changes an exam's date and weight in place (units and their concepts are untouched). */
  'exams:update': { request: { sessionId: number; examId: number; date: string | null; weight: number | null }; response: ExamInfo[] }
  /** The window's time zone and connection, reported at start, on focus and when they change. */
  'clock:report': { request: { timeZone: string; online: boolean }; response: null }
  /** The development date control. Refused in packaged builds. */
  'dev:clock': { request: { action: 'get' | 'move' | 'reset'; days?: number }; response: DevClockState }
  /** Raises the session's call cap, then grades the answers that were waiting for it. */
  'usage:raiseCap': { request: { sessionId: number; callCap: number }; response: UsageSummary }
  'dictation:status': { request: undefined; response: DictationStatus }
  'dictation:selectModel': { request: { model: SpeechModelId }; response: DictationStatus }
  /** Downloads a speech model; progress arrives as dictation:status events. */
  'dictation:download': { request: { model: SpeechModelId }; response: DictationStatus }
  'dictation:cancelDownload': { request: undefined; response: DictationStatus }
  /** Transcribes a bundled half-minute clip with the selected model and reports the time taken. */
  'dictation:speedCheck': { request: undefined; response: SpeedCheckResult }
  /** Asks the operating system for microphone access where it needs asking (macOS). */
  'dictation:prepareMic': { request: undefined; response: { granted: boolean; message: string | null } }
  'dictation:start': { request: undefined; response: { recordingId: number } }
  /** 16 kHz mono samples in [-1, 1], kept in memory only. */
  'dictation:audio': { request: { recordingId: number; samples: Float32Array }; response: null }
  'dictation:stop': { request: { recordingId: number }; response: { text: string } }
  'dictation:cancel': { request: { recordingId: number }; response: null }
}

/** Events the main process pushes to the renderer. */
export interface IpcEvents {
  'ingestion:progress': MaterialSummary
  'models:progress': ModelStatus
  'ingestion:worker': WorkerStatus
  'knowledge:job': JobSummary
  'usage:changed': UsageSummary
  'tutor:lesson': LessonView
  'tutor:stream': StreamEvent
  'dictation:status': DictationStatus
  'reviews:sitting': SittingView
  'reviews:stream': ReviewStreamEvent
}

export type IpcEvent = keyof IpcEvents

export const IPC_EVENTS = [
  'ingestion:progress',
  'models:progress',
  'ingestion:worker',
  'knowledge:job',
  'usage:changed',
  'tutor:lesson',
  'tutor:stream',
  'dictation:status',
  'reviews:sitting',
  'reviews:stream'
] as const satisfies readonly IpcEvent[]

export type IpcChannel = keyof IpcContract
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request']
export type IpcResponse<C extends IpcChannel> = Result<IpcContract[C]['response']>

export const IPC_CHANNELS = [
  'settings:getState',
  'settings:saveKey',
  'settings:clearKey',
  'settings:selectModel',
  'provider:listModels',
  'provider:test',
  'sessions:current',
  'materials:list',
  'materials:add',
  'materials:issues',
  'materials:renderPage',
  'search:query',
  'models:status',
  'models:retry',
  'ingestion:status',
  'consent:get',
  'consent:give',
  'usage:get',
  'usage:setLimits',
  'syllabus:get',
  'syllabus:importFile',
  'syllabus:importText',
  'syllabus:save',
  'units:list',
  'knowledge:estimateUnit',
  'knowledge:approve',
  'knowledge:pause',
  'knowledge:resume',
  'knowledge:cancel',
  'knowledge:jobs',
  'concepts:review',
  'concepts:rename',
  'concepts:merge',
  'concepts:delete',
  'concepts:link',
  'concepts:unlink',
  'tutor:path',
  'diagnostic:start',
  'diagnostic:state',
  'diagnostic:answer',
  'standing:claimKnown',
  'standing:markNew',
  'lesson:open',
  'lesson:current',
  'lesson:answer',
  'lesson:continue',
  'lesson:contest',
  'lesson:draft',
  'lesson:more',
  'lesson:retry',
  'lesson:interleaveAnswer',
  'reviews:today',
  'reviews:start',
  'reviews:current',
  'reviews:shown',
  'reviews:answer',
  'reviews:hint',
  'reviews:draft',
  'reviews:contest',
  'reviews:reteach',
  'reviews:reteachAnswer',
  'reviews:skipToday',
  'reviews:setLimit',
  'reviews:progress',
  'exams:list',
  'exams:update',
  'clock:report',
  'dev:clock',
  'usage:raiseCap',
  'dictation:status',
  'dictation:selectModel',
  'dictation:download',
  'dictation:cancelDownload',
  'dictation:speedCheck',
  'dictation:prepareMic',
  'dictation:start',
  'dictation:audio',
  'dictation:stop',
  'dictation:cancel'
] as const satisfies readonly IpcChannel[]

/** The API the preload script exposes on window.feynmind. */
export type FeynMindApi = {
  [C in IpcChannel]: IpcRequest<C> extends undefined
    ? () => Promise<IpcResponse<C>>
    : (request: IpcRequest<C>) => Promise<IpcResponse<C>>
} & {
  /** Subscribes to an event from the main process. Returns a function that unsubscribes. */
  on: <E extends IpcEvent>(event: E, listener: (payload: IpcEvents[E]) => void) => () => void
}
