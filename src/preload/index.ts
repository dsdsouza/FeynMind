import { contextBridge, ipcRenderer } from 'electron'
import type { FeynMindApi, IpcChannel, IpcRequest, IpcResponse } from '../shared/ipc'

// The only bridge between the renderer and the main process.
// Each function invokes one channel from the shared contract; nothing else is exposed.
function invoke<C extends IpcChannel>(channel: C, request?: IpcRequest<C>): Promise<IpcResponse<C>> {
  return ipcRenderer.invoke(channel, request) as Promise<IpcResponse<C>>
}

const api: FeynMindApi = {
  'settings:getState': () => invoke('settings:getState'),
  'settings:saveKey': (request) => invoke('settings:saveKey', request),
  'settings:clearKey': () => invoke('settings:clearKey'),
  'settings:selectModel': (request) => invoke('settings:selectModel', request),
  'provider:listModels': () => invoke('provider:listModels'),
  'provider:test': () => invoke('provider:test')
}

contextBridge.exposeInMainWorld('feynmind', api)
