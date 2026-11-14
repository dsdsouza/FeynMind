import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcChannel, IpcContract, IpcRequest, IpcResponse } from '../shared/ipc'
import type { SyllabusDraft } from '../shared/knowledge'
import type { IngestionService } from './ingestion'
import type { KnowledgeService } from './knowledge'
import type { ProviderService } from './providers'
import type { SessionStore } from './storage'
import type { TutorService } from './tutor'

export interface IpcServices {
  providers: ProviderService
  ingestion: IngestionService
  sessions: SessionStore
  knowledge: KnowledgeService
  tutor: TutorService
  /** Shows a file picker for course materials; returns the chosen paths (empty when cancelled). */
  pickMaterialFiles: () => Promise<string[]>
  /** Shows a file picker for a syllabus PDF; returns its path, or null when cancelled. */
  pickSyllabusFile: () => Promise<string | null>
}

type Handlers = {
  [C in IpcChannel]: (request: IpcRequest<C>) => IpcContract[C]['response'] | Promise<IpcContract[C]['response']>
}

class InvalidRequestError extends Error {}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new InvalidRequestError('Invalid request.')
  return value as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new InvalidRequestError(`Invalid request: ${field} must be text.`)
  return value
}

function requireId(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidRequestError(`Invalid request: ${field} must be a positive whole number.`)
  }
  return value
}

/** A whole number from 0, such as the position of a chosen answer. */
function requireIndex(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new InvalidRequestError(`Invalid request: ${field} must be a whole number of 0 or more.`)
  return value
}

/** A whole number, a decimal or null; for optional caps and prices. */
function optionalNumber(value: unknown, field: string, integer: boolean): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new InvalidRequestError(`Invalid request: ${field} must be ${integer ? 'a whole number' : 'a number'} of 0 or more, or empty.`)
  }
  return value
}

/** Checks that a session exists, so a renderer cannot reach another session's data by guessing ids. */
function requireSession(services: IpcServices, request: unknown): number {
  const id = requireId(requireObject(request).sessionId, 'sessionId')
  services.sessions.get(id)
  return id
}

function handlersFor(services: IpcServices): Handlers {
  const { providers, ingestion, sessions, knowledge, tutor } = services
  const unitId = (req: unknown): number => requireId(requireObject(req).unitId, 'unitId')
  const jobId = (req: unknown): number => requireId(requireObject(req).jobId, 'jobId')
  const lessonId = (req: unknown): number => requireId(requireObject(req).lessonId, 'lessonId')
  return {
    'settings:getState': () => providers.getState(),
    'settings:saveKey': (req) => providers.saveKey(requireString(requireObject(req).apiKey, 'apiKey')),
    'settings:clearKey': () => providers.clearKey(),
    'settings:selectModel': (req) => providers.selectModel(requireString(requireObject(req).modelId, 'modelId')),
    'provider:listModels': () => providers.listModels(),
    'provider:test': () => providers.test(),
    'sessions:current': () => sessions.current(),
    'materials:list': (req) => ingestion.listMaterials(requireSession(services, req)),
    'materials:add': async (req) => {
      const sessionId = requireSession(services, req)
      const paths = await services.pickMaterialFiles()
      return paths.length === 0 ? null : ingestion.addFiles(sessionId, paths)
    },
    'materials:issues': (req) => ingestion.pageIssues(requireId(requireObject(req).materialId, 'materialId')),
    'materials:renderPage': async (req) => {
      const r = requireObject(req)
      const png = await ingestion.renderPage(requireId(r.materialId, 'materialId'), requireId(r.pageIndex, 'pageIndex'))
      return png === null ? null : `data:image/png;base64,${png}`
    },
    'search:query': (req) => ingestion.search(requireSession(services, req), requireString(requireObject(req).query, 'query')),
    'models:status': () => ingestion.getModelStatus(),
    'models:retry': () => ingestion.retryModel(),
    'ingestion:status': () => ingestion.getWorkerStatus(),
    'consent:get': (req) => knowledge.consent(requireSession(services, req)),
    'consent:give': (req) => knowledge.giveConsent(requireSession(services, req)),
    'usage:get': (req) => providers.usageSummary(requireSession(services, req)),
    'usage:setLimits': (req) => {
      const sessionId = requireSession(services, req)
      const r = requireObject(req)
      const rpm = requireId(r.requestsPerMinute, 'requestsPerMinute')
      const callCap = optionalNumber(r.callCap, 'callCap', true)
      const spendCapUsd = optionalNumber(r.spendCapUsd, 'spendCapUsd', false)
      let price: { input: number; output: number } | null = null
      if (r.price !== null) {
        const p = requireObject(r.price)
        price = { input: optionalNumber(p.input, 'price.input', false) ?? 0, output: optionalNumber(p.output, 'price.output', false) ?? 0 }
      }
      providers.setRequestsPerMinute(rpm)
      const model = providers.getState().selectedModel
      if (model) providers.setPrice(model, price)
      sessions.setLimits(sessionId, { callCap, spendCapUsd })
      return providers.usageSummary(sessionId)
    },
    'syllabus:get': (req) => knowledge.syllabusState(requireSession(services, req)),
    'syllabus:importFile': async (req) => {
      const sessionId = requireSession(services, req)
      const path = await services.pickSyllabusFile()
      return path === null ? null : knowledge.startSyllabusFromFile(sessionId, path)
    },
    'syllabus:importText': (req) => knowledge.startSyllabusFromText(requireSession(services, req), requireString(requireObject(req).text, 'text')),
    'syllabus:save': (req) => {
      const r = requireObject(req)
      const draft = requireObject(r.draft)
      if (!Array.isArray(draft.units) || !Array.isArray(draft.exams)) throw new InvalidRequestError('Invalid request: draft must have units and exams.')
      return knowledge.saveSyllabus(requireId(r.syllabusId, 'syllabusId'), draft as unknown as SyllabusDraft)
    },
    'units:list': (req) => knowledge.units(requireSession(services, req)),
    'knowledge:estimateUnit': (req) => knowledge.estimateUnit(unitId(req)),
    'knowledge:approve': (req) => knowledge.approve(jobId(req)),
    'knowledge:pause': (req) => knowledge.pause(jobId(req)),
    'knowledge:resume': (req) => knowledge.resume(jobId(req)),
    'knowledge:cancel': (req) => knowledge.cancel(jobId(req)),
    'knowledge:jobs': (req) => knowledge.jobs(requireSession(services, req)),
    'concepts:review': (req) => knowledge.review(unitId(req)),
    'concepts:rename': (req) => {
      const r = requireObject(req)
      const definition = r.definition === null ? null : requireString(r.definition, 'definition')
      return knowledge.renameConcept(unitId(req), requireId(r.conceptId, 'conceptId'), requireString(r.name, 'name'), definition)
    },
    'concepts:merge': (req) => {
      const r = requireObject(req)
      return knowledge.mergeConcepts(unitId(req), requireId(r.fromId, 'fromId'), requireId(r.intoId, 'intoId'))
    },
    'concepts:delete': (req) => knowledge.deleteConcept(unitId(req), requireId(requireObject(req).conceptId, 'conceptId')),
    'concepts:link': (req) => {
      const r = requireObject(req)
      return knowledge.linkConcepts(unitId(req), requireId(r.conceptId, 'conceptId'), requireId(r.prereqId, 'prereqId'))
    },
    'concepts:unlink': (req) => {
      const r = requireObject(req)
      return knowledge.unlinkConcepts(unitId(req), requireId(r.conceptId, 'conceptId'), requireId(r.prereqId, 'prereqId'))
    },
    'tutor:path': (req) => tutor.path(requireSession(services, req)),
    'diagnostic:start': (req) => tutor.startDiagnostic(requireSession(services, req)),
    'diagnostic:state': (req) => tutor.diagnosticState(requireId(requireObject(req).diagnosticId, 'diagnosticId')),
    'diagnostic:answer': (req) => {
      const r = requireObject(req)
      const choice = r.choice === null ? null : requireIndex(r.choice, 'choice')
      return tutor.answerDiagnostic(requireId(r.diagnosticId, 'diagnosticId'), requireId(r.questionId, 'questionId'), choice)
    },
    'standing:claimKnown': (req) => tutor.claimUnitKnown(requireSession(services, req), unitId(req)),
    'standing:markNew': (req) => tutor.markUnitNew(requireSession(services, req), unitId(req)),
    'lesson:open': (req) => tutor.openLesson(requireSession(services, req), requireId(requireObject(req).conceptId, 'conceptId')),
    'lesson:current': (req) => tutor.currentLesson(requireSession(services, req)),
    'lesson:answer': (req) => {
      const r = requireObject(req)
      if (typeof r.skipped !== 'boolean') throw new InvalidRequestError('Invalid request: skipped must be true or false.')
      const reasoning = r.reasoning === undefined ? '' : requireString(r.reasoning, 'reasoning')
      return tutor.answer(lessonId(req), requireId(r.questionId, 'questionId'), requireString(r.answer, 'answer'), r.skipped, reasoning)
    },
    'lesson:continue': (req) => tutor.continue(lessonId(req), requireObject(req).fastTrack === true),
    'lesson:contest': (req) => {
      const r = requireObject(req)
      return tutor.contest(requireId(r.attemptId, 'attemptId'), requireString(r.objection, 'objection'))
    },
    'lesson:draft': (req) => {
      const r = requireObject(req)
      if (r.field !== 'answer' && r.field !== 'reasoning') throw new InvalidRequestError('Invalid request: field must be "answer" or "reasoning".')
      tutor.saveDraft(lessonId(req), r.field, requireString(r.text, 'text'))
      return null
    },
    'lesson:more': (req) => tutor.moreQuestions(lessonId(req)),
    'lesson:retry': (req) => tutor.retry(lessonId(req)),
    'usage:raiseCap': (req) => {
      const sessionId = requireSession(services, req)
      const callCap = requireId(requireObject(req).callCap, 'callCap')
      const limits = sessions.limits(sessionId)
      sessions.setLimits(sessionId, { callCap, spendCapUsd: limits.spendCapUsd })
      tutor.resumePending(sessionId)
      return providers.usageSummary(sessionId)
    }
  }
}

/**
 * Registers one handler per channel in the shared contract. Requests from the renderer are
 * validated at runtime, and every error is converted to a redacted, user-safe message.
 * `isTrustedSender` rejects calls from any frame other than the app's own page.
 */
export function registerIpcHandlers(services: IpcServices, isTrustedSender: (event: IpcMainInvokeEvent) => boolean): void {
  const { providers } = services
  const handlers = handlersFor(services)
  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    const handler = handlers[channel] as (request: unknown) => unknown
    ipcMain.handle(channel, async (event, request: unknown): Promise<IpcResponse<typeof channel>> => {
      if (!isTrustedSender(event)) return { ok: false, error: 'Request rejected.' }
      try {
        const value = (await handler(request)) as IpcContract[typeof channel]['response']
        return { ok: true, value }
      } catch (error) {
        const message = providers.safeErrorMessage(error)
        // Only the redacted message is ever logged.
        console.error(`[ipc] ${channel} failed: ${message}`)
        return { ok: false, error: message }
      }
    })
  }
}
