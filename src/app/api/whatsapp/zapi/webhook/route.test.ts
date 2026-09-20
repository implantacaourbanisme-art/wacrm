import { describe, expect, it } from 'vitest'
import { mapZApiStatus, normalizeContent } from './route'
import { classifyZApiMessageEvent } from '@/lib/whatsapp/mirror-mode'

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

describe('classifyZApiMessageEvent contract used by the webhook route', () => {
  it('uses the shared classifier: fromMe is only ingested in mirror mode', () => {
    expect(classifyZApiMessageEvent({ fromMe: true }, false)).toBe('skip_outbound_echo')
    expect(classifyZApiMessageEvent({ fromMe: true }, true)).toBe('ingest_outbound')
  })
})

describe('normalizeContent — messages we sent (mirror mode)', () => {
  it('renders a list menu as readable text with its options', () => {
    const res = normalizeContent({
      instanceId: 'inst-1',
      messageId: 'msg-7',
      fromMe: true,
      listMessage: {
        description: 'Escolha abaixo a opção desejada.',
        footerText: null,
        title: null,
        buttonText: 'Ver Opções',
        sections: [
          {
            title: null,
            options: [
              { title: 'Comercial', description: '', rowId: 'Comercial' },
              { title: 'Financeiro', description: '', rowId: 'Financeiro' },
            ],
          },
        ],
      },
    })
    expect(res.contentType).toBe('text')
    expect(res.rawTypeLabel).toBe('listMessage')
    expect(res.interactiveReplyId).toBeNull()
    expect(res.contentText).toBe(
      'Escolha abaixo a opção desejada.\n\n• Comercial\n• Financeiro'
    )
  })

  it('includes list title, footer and option descriptions when present', () => {
    const res = normalizeContent({
      instanceId: 'inst-1',
      messageId: 'msg-8',
      listMessage: {
        description: 'Menu',
        footerText: 'Rodapé',
        title: 'Título',
        sections: [
          { title: 'Setores', options: [{ title: 'Jurídico', description: 'Contratos', rowId: 'j' }] },
        ],
      },
    })
    expect(res.contentText).toBe('Título\nMenu\n\nSetores\n• Jurídico — Contratos\n\nRodapé')
  })

  it('renders a buttons message with its button labels', () => {
    const res = normalizeContent({
      instanceId: 'inst-1',
      messageId: 'msg-9',
      buttonsMessage: {
        message: 'Como posso ajudar?',
        buttons: [
          { buttonId: '1', buttonText: { displayText: '2 Via' } },
          { buttonId: '2', buttonText: { displayText: 'Demonstrativo' } },
        ],
      },
    })
    expect(res.contentType).toBe('text')
    expect(res.rawTypeLabel).toBe('buttonsMessage')
    expect(res.contentText).toBe('Como posso ajudar?\n\n• 2 Via\n• Demonstrativo')
  })

  it('still falls back to the unsupported label for unknown shapes', () => {
    const res = normalizeContent({ instanceId: 'inst-1', messageId: 'msg-10' })
    expect(res.contentText).toBe('[Unsupported message type]')
  })
})
