import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcChannel, IpcContract, IpcRequest, IpcResponse } from '../shared/ipc'
import type { IngestionService } from './ingestion'
import type { ProviderService } from './providers'
import type { SessionStore } from './storage'

export interface IpcServices {
  providers: ProviderService
  ingestion: IngestionService
  sessions: SessionStore
  /** Shows a file picker for course materials; returns the chosen paths (empty when cancelled). */
  pickMaterialFiles: () => Promise<string[]>
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

/** Checks that a session exists, so a renderer cannot reach another session's data by guessing ids. */
function requireSession(services: IpcServices, request: unknown): number {
  const id = requireId(requireObject(request).sessionId, 'sessionId')
  services.sessions.get(id)
  return id
}

function handlersFor(services: IpcServices): Handlers {
  const { providers, ingestion, sessions } = services
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
    'models:retry': () => ingestion.retryModel()
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
