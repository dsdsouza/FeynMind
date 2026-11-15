// Which permission requests from web content are granted. Only the microphone, only for the app's
// own window showing the app's own page, and only audio: no camera, screen, notifications,
// location, devices or anything else.

export interface PermissionQuestion {
  permission: string
  /** For 'media': the kinds asked for ('audio', 'video'). Empty or missing when unknown. */
  mediaTypes: readonly string[]
  /** The URL of the page or frame asking. */
  url: string
  /** True when the asking web contents is the app's main window. */
  fromAppWindow: boolean
}

export function allowPermission(q: PermissionQuestion, isAppUrl: (url: string) => boolean): boolean {
  if (q.permission !== 'media') return false
  if (!q.fromAppWindow || !isAppUrl(q.url)) return false
  return q.mediaTypes.length > 0 && q.mediaTypes.every((t) => t === 'audio')
}
