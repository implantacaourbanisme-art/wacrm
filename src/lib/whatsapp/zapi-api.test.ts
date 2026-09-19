import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  zapiSendText,
  zapiSendMedia,
  zapiSendReaction,
  getInstanceStatus,
  getQrCodeImage,
  configureReceivedWebhook,
  configureMessageStatusWebhook,
  ZApiError,
} from './zapi-api'

const CREDS = { instanceId: 'inst-1', instanceToken: 'itok', clientToken: 'ctok' }

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

describe('zapi-api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('zapiSendText posts to the instance URL with the Client-Token header', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedInit = init
        return jsonResponse({ messageId: 'wamid.abc' })
      }),
    )

    const result = await zapiSendText({ ...CREDS, phone: '5511999999999', message: 'oi' })

    expect(result.messageId).toBe('wamid.abc')
    expect(capturedUrl).toBe(
      'https://api.z-api.io/instances/inst-1/token/itok/send-text',
    )
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['Client-Token']).toBe('ctok')
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      phone: '5511999999999',
      message: 'oi',
    })
  })

  it('zapiSendText throws ZApiError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'invalid phone' }, 400)))
    await expect(
      zapiSendText({ ...CREDS, phone: 'bad', message: 'oi' }),
    ).rejects.toMatchObject({ message: 'invalid phone', httpStatus: 400 })
  })

  it('zapiSendText throws when the response carries no message id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})))
    await expect(
      zapiSendText({ ...CREDS, phone: '5511999999999', message: 'oi' }),
    ).rejects.toBeInstanceOf(ZApiError)
  })

  it('zapiSendMedia routes documents through send-document/<extension>', async () => {
    let capturedUrl = ''
    let capturedBody: Record<string, unknown> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedBody = JSON.parse(init?.body as string)
        return jsonResponse({ zaapId: 'z-1' })
      }),
    )

    const result = await zapiSendMedia({
      ...CREDS,
      phone: '5511999999999',
      kind: 'document',
      link: 'https://example.com/invoice.pdf',
      filename: 'invoice.pdf',
    })

    expect(result.messageId).toBe('z-1')
    expect(capturedUrl).toBe(
      'https://api.z-api.io/instances/inst-1/token/itok/send-document/pdf',
    )
    expect(capturedBody.fileName).toBe('invoice.pdf')
    expect(capturedBody.document).toBe('https://example.com/invoice.pdf')
  })

  it('zapiSendMedia falls back to a generic document slot with no filename', async () => {
    let capturedUrl = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url
        return jsonResponse({ id: 'z-2' })
      }),
    )

    await zapiSendMedia({
      ...CREDS,
      phone: '5511999999999',
      kind: 'document',
      link: 'https://example.com/file',
    })

    expect(capturedUrl).toBe(
      'https://api.z-api.io/instances/inst-1/token/itok/send-document/pdf',
    )
  })

  it('zapiSendMedia routes image/video/audio to send-<kind>', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        return jsonResponse({ id: 'z-3' })
      }),
    )

    for (const kind of ['image', 'video', 'audio'] as const) {
      await zapiSendMedia({ ...CREDS, phone: '5511999999999', kind, link: 'https://x/file' })
    }

    expect(urls).toEqual([
      'https://api.z-api.io/instances/inst-1/token/itok/send-image',
      'https://api.z-api.io/instances/inst-1/token/itok/send-video',
      'https://api.z-api.io/instances/inst-1/token/itok/send-audio',
    ])
  })

  it('getInstanceStatus reports connected state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ connected: true, phone: '5511999999999' })),
    )
    const status = await getInstanceStatus(CREDS)
    expect(status).toEqual({ connected: true, phone: '5511999999999', smartphoneConnected: undefined })
  })

  it('getQrCodeImage returns the value on 200, null otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ value: 'data:image/png;base64,AAA' })))
    const qr = await getQrCodeImage(CREDS)
    expect(qr?.value).toBe('data:image/png;base64,AAA')

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 403)))
    const qrWhenConnected = await getQrCodeImage(CREDS)
    expect(qrWhenConnected).toBeNull()
  })

  it('configureReceivedWebhook PUTs the webhook URL', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedInit = init
        return jsonResponse({})
      }),
    )

    await configureReceivedWebhook({
      ...CREDS,
      webhookUrl: 'https://app.example.com/api/whatsapp/zapi/webhook',
    })

    expect(capturedUrl).toBe(
      'https://api.z-api.io/instances/inst-1/token/itok/update-webhook-received',
    )
    expect(capturedInit?.method).toBe('PUT')
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      value: 'https://app.example.com/api/whatsapp/zapi/webhook',
    })
  })

  it('configureReceivedWebhook throws ZApiError on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'bad token' }, 401)))
    await expect(
      configureReceivedWebhook({ ...CREDS, webhookUrl: 'https://x/webhook' }),
    ).rejects.toMatchObject({ message: 'bad token' })
  })

  it('configureMessageStatusWebhook PUTs the webhook URL to its own endpoint', async () => {
    let capturedUrl = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url
        return jsonResponse({})
      }),
    )
    await configureMessageStatusWebhook({
      ...CREDS,
      webhookUrl: 'https://app.example.com/api/whatsapp/zapi/webhook',
    })
    expect(capturedUrl).toBe(
      'https://api.z-api.io/instances/inst-1/token/itok/update-webhook-message-status',
    )
  })

  it('zapiSendReaction posts phone/messageId/reaction to send-reaction', async () => {
    let capturedUrl = ''
    let capturedBody: Record<string, unknown> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedBody = JSON.parse(init?.body as string)
        return jsonResponse({ messageId: 'z-react-1' })
      }),
    )

    const result = await zapiSendReaction({
      ...CREDS,
      phone: '5511999999999',
      messageId: 'wamid-1',
      emoji: '❤️',
    })

    expect(result.messageId).toBe('z-react-1')
    expect(capturedUrl).toBe(
      'https://api.z-api.io/instances/inst-1/token/itok/send-reaction',
    )
    expect(capturedBody).toEqual({
      phone: '5511999999999',
      messageId: 'wamid-1',
      reaction: '❤️',
    })
  })

  it('zapiSendReaction sends an empty reaction to remove one', async () => {
    let capturedBody: Record<string, unknown> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string)
        return jsonResponse({ messageId: 'z-react-2' })
      }),
    )
    await zapiSendReaction({ ...CREDS, phone: '5511999999999', messageId: 'wamid-1', emoji: '' })
    expect(capturedBody.reaction).toBe('')
  })
})
