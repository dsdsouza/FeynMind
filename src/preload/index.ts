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
  'ingestion:status': () => invoke('ingestion:status'),
  'consent:get': (request) => invoke('consent:get', request),
  'consent:give': (request) => invoke('consent:give', request),
  'usage:get': (request) => invoke('usage:get', request),
  'usage:setLimits': (request) => invoke('usage:setLimits', request),
  'syllabus:get': (request) => invoke('syllabus:get', request),
  'syllabus:importFile': (request) => invoke('syllabus:importFile', request),
  'syllabus:importText': (request) => invoke('syllabus:importText', request),
  'syllabus:save': (request) => invoke('syllabus:save', request),
  'units:list': (request) => invoke('units:list', request),
  'knowledge:estimateUnit': (request) => invoke('knowledge:estimateUnit', request),
  'knowledge:approve': (request) => invoke('knowledge:approve', request),
  'knowledge:pause': (request) => invoke('knowledge:pause', request),
  'knowledge:resume': (request) => invoke('knowledge:resume', request),
  'knowledge:cancel': (request) => invoke('knowledge:cancel', request),
  'knowledge:jobs': (request) => invoke('knowledge:jobs', request),
  'concepts:review': (request) => invoke('concepts:review', request),
  'concepts:rename': (request) => invoke('concepts:rename', request),
  'concepts:merge': (request) => invoke('concepts:merge', request),
  'concepts:delete': (request) => invoke('concepts:delete', request),
  'concepts:link': (request) => invoke('concepts:link', request),
  'concepts:unlink': (request) => invoke('concepts:unlink', request),
  'tutor:path': (request) => invoke('tutor:path', request),
  'diagnostic:start': (request) => invoke('diagnostic:start', request),
  'diagnostic:state': (request) => invoke('diagnostic:state', request),
  'diagnostic:answer': (request) => invoke('diagnostic:answer', request),
  'standing:claimKnown': (request) => invoke('standing:claimKnown', request),
  'standing:markNew': (request) => invoke('standing:markNew', request),
  'lesson:open': (request) => invoke('lesson:open', request),
  'lesson:current': (request) => invoke('lesson:current', request),
  'lesson:answer': (request) => invoke('lesson:answer', request),
  'lesson:continue': (request) => invoke('lesson:continue', request),
  'lesson:contest': (request) => invoke('lesson:contest', request),
  'lesson:draft': (request) => invoke('lesson:draft', request),
  'lesson:more': (request) => invoke('lesson:more', request),
  'lesson:retry': (request) => invoke('lesson:retry', request),
  'lesson:interleaveAnswer': (request) => invoke('lesson:interleaveAnswer', request),
  'reviews:today': (request) => invoke('reviews:today', request),
  'reviews:start': (request) => invoke('reviews:start', request),
  'reviews:current': (request) => invoke('reviews:current', request),
  'reviews:shown': (request) => invoke('reviews:shown', request),
  'reviews:answer': (request) => invoke('reviews:answer', request),
  'reviews:hint': (request) => invoke('reviews:hint', request),
  'reviews:draft': (request) => invoke('reviews:draft', request),
  'reviews:contest': (request) => invoke('reviews:contest', request),
  'reviews:reteach': (request) => invoke('reviews:reteach', request),
  'reviews:reteachAnswer': (request) => invoke('reviews:reteachAnswer', request),
  'reviews:skipToday': (request) => invoke('reviews:skipToday', request),
  'reviews:setLimit': (request) => invoke('reviews:setLimit', request),
  'reviews:progress': (request) => invoke('reviews:progress', request),
  'exams:list': (request) => invoke('exams:list', request),
  'exams:update': (request) => invoke('exams:update', request),
  'clock:report': (request) => invoke('clock:report', request),
  'dev:clock': (request) => invoke('dev:clock', request),
  'usage:raiseCap': (request) => invoke('usage:raiseCap', request),
  'dictation:status': () => invoke('dictation:status'),
  'dictation:selectModel': (request) => invoke('dictation:selectModel', request),
  'dictation:download': (request) => invoke('dictation:download', request),
  'dictation:cancelDownload': () => invoke('dictation:cancelDownload'),
  'dictation:speedCheck': () => invoke('dictation:speedCheck'),
  'dictation:prepareMic': () => invoke('dictation:prepareMic'),
  'dictation:start': () => invoke('dictation:start'),
  'dictation:audio': (request) => invoke('dictation:audio', request),
  'dictation:stop': (request) => invoke('dictation:stop', request),
  'dictation:cancel': (request) => invoke('dictation:cancel', request),
  on
}

contextBridge.exposeInMainWorld('feynmind', api)
