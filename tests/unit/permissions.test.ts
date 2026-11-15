import { describe, expect, it } from 'vitest'
import { allowPermission } from '../../src/main/permissions'

const isAppUrl = (url: string) => url.startsWith('file://')
const ask = (over: Partial<Parameters<typeof allowPermission>[0]>) =>
  allowPermission({ permission: 'media', mediaTypes: ['audio'], url: 'file:///app/index.html', fromAppWindow: true, ...over }, isAppUrl)

describe('permissions', () => {
  it('allows the microphone for the app window on the app page', () => {
    expect(ask({})).toBe(true)
  })

  it('denies video, screen capture and requests that do not say what they want', () => {
    expect(ask({ mediaTypes: ['audio', 'video'] })).toBe(false)
    expect(ask({ mediaTypes: ['video'] })).toBe(false)
    expect(ask({ mediaTypes: [] })).toBe(false)
  })

  it('denies other windows and other pages', () => {
    expect(ask({ fromAppWindow: false })).toBe(false)
    expect(ask({ url: 'https://example.com/' })).toBe(false)
  })

  it('denies every other permission', () => {
    for (const permission of ['notifications', 'geolocation', 'display-capture', 'clipboard-read', 'midi', 'openExternal', 'fullscreen', 'pointerLock', 'hid', 'serial', 'usb']) {
      expect(ask({ permission })).toBe(false)
    }
  })
})
