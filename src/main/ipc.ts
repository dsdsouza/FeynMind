import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcChannel, IpcContract, IpcRequest, IpcResponse } from '../shared/ipc'
import type { SyllabusDraft } from '../shared/knowledge'
import type { IngestionService } from './ingestion'
import type { KnowledgeService } from './knowledge'
import type { ProviderService } from './providers'
import type { SessionStore } from './storage'

export interface IpcServices {
  providers: ProviderService
  ingestion: IngestionService
  sessions: SessionStore
  knowledge: KnowledgeService
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
  const { providers, ingestion, sessions, knowledge } = services
  const unitId = (req: unknown): number => requireId(requireObject(req).unitId, 'unitId')
  const jobId = (req: unknown): number => requireId(requireObject(req).jobId, 'jobId')
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
