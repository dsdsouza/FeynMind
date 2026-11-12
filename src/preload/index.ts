import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC_EVENTS, type FeynMindApi, type IpcChannel, type IpcEvent, type IpcEvents, type IpcRequest, type IpcResponse } from '../shared/ipc'

// The only bridge between the renderer and the main process.
// Each function invokes one channel from the shared contract; nothing else is exposed.
function invoke<C extends IpcChannel>(channel: C, request?: IpcRequest<C>): Promise<IpcResponse<C>> {
  return ipcRenderer.invoke(channel, request) as Promise<IpcResponse<C>>
}

const allowedEvents = new Set<string>(IPC_EVENTS)

function on<E extends IpcEvent>(event: E, listener: (payload: IpcEvents[E]) => void): () => void {
  if (!allowedEvents.has(event)) throw new Error(`Unknown event: ${event}`)
  // Only the payload reaches the page; the IPC event object (and its sender) never does.
  const wrapped = (_event: IpcRendererEvent, payload: IpcEvents[E]): void => listener(payload)
  ipcRenderer.on(event, wrapped)
  return () => {
    ipcRenderer.removeListener(event, wrapped)
  }
}

const api: FeynMindApi = {
  'settings:getState': () => invoke('settings:getState'),
  'settings:saveKey': (request) => invoke('settings:saveKey', request),
  'settings:clearKey': () => invoke('settings:clearKey'),
  'settings:selectModel': (request) => invoke('settings:selectModel', request),
  'provider:listModels': () => invoke('provider:listModels'),
  'provider:test': () => invoke('provider:test'),
  'sessions:current': () => invoke('sessions:current'),
  'materials:list': (request) => invoke('materials:list', request),
  'materials:add': (request) => invoke('materials:add', request),
  'materials:issues': (request) => invoke('materials:issues', request),
  'materials:renderPage': (request) => invoke('materials:renderPage', request),
  'search:query': (request) => invoke('search:query', request),
  'models:status': () => invoke('models:status'),
  'models:retry': () => invoke('models:retry'),
  on
}

contextBridge.exposeInMainWorld('feynmind', api)
