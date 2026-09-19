import { describe, expect, it } from 'vitest'
import { mapZApiStatus } from './route'
import { mapZApiStatus, normalizeContent } from './route'

describe('mapZApiStatus', () => {
  it('maps SENT to sent', () => {
    expect(mapZApiStatus('SENT')).toBe('sent')
  })
  it('maps RECEIVED to delivered', () => {
    expect(mapZApiStatus('RECEIVED')).toBe('delivered')
  })
  it('maps READ to read', () => {
    expect(mapZApiStatus('READ')).toBe('read')
  })
  it('maps PLAYED to read', () => {
    expect(mapZApiStatus('PLAYED')).toBe('read')
  })
  it('maps READ_BY_ME to null — not a signal about the customer', () => {
    expect(mapZApiStatus('READ_BY_ME')).toBeNull()
  })
  it('maps an unrecognized value to null', () => {
    expect(mapZApiStatus('SOMETHING_NEW')).toBeNull()
  })
  it('maps undefined to null', () => {
    expect(mapZApiStatus(undefined)).toBeNull()
  })
})

describe('normalizeContent', () => {
  it('normalizes standard text payload with text.message', () => {
    const res = normalizeContent({
      instanceId: 'inst-1',
      messageId: 'msg-1',
      text: { message: 'Hello from WhatsApp' },
    })
    expect(res.contentType).toBe('text')
    expect(res.contentText).toBe('Hello from WhatsApp')
  })

  it('normalizes payload when text is a plain string', () => {
    const res = normalizeContent({
      instanceId: 'inst-1',
      messageId: 'msg-2',
      text: 'Direct text string' as any,
    })
    expect(res.contentType).toBe('text')
    expect(res.contentText).toBe('Direct text string')
  })

  it('normalizes payload when text is in message.conversation', () => {
    const res = normalizeContent({
      instanceId: 'inst-1',
      messageId: 'msg-3',
      message: { conversation: 'Nested conversation text' },
    })
    expect(res.contentType).toBe('text')
    expect(res.contentText).toBe('Nested conversation text')
  })

  it('normalizes image payload with caption', () => {
    const res = normalizeContent({
      instanceId: 'inst-1',
      messageId: 'msg-4',
      image: {
        imageUrl: 'https://cdn.z-api.io/img.jpg',
        mimeType: 'image/jpeg',
        caption: 'Look at this photo',
      },
    })
    expect(res.contentType).toBe('image')
    expect(res.mediaUrl).toBe('https://cdn.z-api.io/img.jpg')
    expect(res.contentText).toBe('Look at this photo')
  })

  it('normalizes location payload', () => {
    const res = normalizeContent({
      instanceId: 'inst-1',
      messageId: 'msg-5',
      location: {
        name: 'Av. Paulista',
        address: 'São Paulo, SP',
        latitude: -23.561684,
        longitude: -46.655981,
      },
    })
    expect(res.contentType).toBe('location')
    expect(res.contentText).toContain('Av. Paulista')
    expect(res.contentText).toContain('maps.google.com')
  })

  it('normalizes sticker payload to image', () => {
    const res = normalizeContent({
      instanceId: 'inst-1',
      messageId: 'msg-6',
      sticker: {
        stickerUrl: 'https://cdn.z-api.io/sticker.webp',
      },
    })
    expect(res.contentType).toBe('image')
    expect(res.mediaUrl).toBe('https://cdn.z-api.io/sticker.webp')
  })
})
