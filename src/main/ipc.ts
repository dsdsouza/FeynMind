import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcChannel, IpcContract, IpcRequest, IpcResponse } from '../shared/ipc'
import type { ProviderService } from './providers'

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

function handlersFor(providers: ProviderService): Handlers {
  return {
    'settings:getState': () => providers.getState(),
    'settings:saveKey': (req) => providers.saveKey(requireString(requireObject(req).apiKey, 'apiKey')),
    'settings:clearKey': () => providers.clearKey(),
    'settings:selectModel': (req) => providers.selectModel(requireString(requireObject(req).modelId, 'modelId')),
    'provider:listModels': () => providers.listModels(),
    'provider:test': () => providers.test()
  }
}

/**
 * Registers one handler per channel in the shared contract. Requests from the renderer are
 * validated at runtime, and every error is converted to a redacted, user-safe message.
 * `isTrustedSender` rejects calls from any frame other than the app's own page.
 */
export function registerIpcHandlers(
  providers: ProviderService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
): void {
  const handlers = handlersFor(providers)
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
