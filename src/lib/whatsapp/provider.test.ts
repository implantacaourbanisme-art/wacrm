import { afterEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from './encryption'
import { resolveSendProvider } from './provider'

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

describe('resolveSendProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to Meta when provider is unset (pre-migration-043 rows)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ messages: [{ id: 'wamid.1' }] })))
    const sendProvider = resolveSendProvider({
      phone_number_id: '1234567890',
      access_token: encrypt('meta-token'),
    })
    expect(sendProvider.kind).toBe('meta')
    const result = await sendProvider.sendText({ to: '5511999999999', text: 'hi' })
    expect(result.messageId).toBe('wamid.1')
  })

  it('resolves the Meta provider and decrypts the access token for the call', async () => {
    let capturedAuth = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedAuth = (init?.headers as Record<string, string>).Authorization
        return jsonResponse({ messages: [{ id: 'wamid.2' }] })
      }),
    )
    const sendProvider = resolveSendProvider({
      provider: 'meta',
      phone_number_id: '1234567890',
      access_token: encrypt('secret-meta-token'),
    })
    await sendProvider.sendText({ to: '5511999999999', text: 'hi' })
    expect(capturedAuth).toBe('Bearer secret-meta-token')
  })

  it('resolves the Z-API provider and decrypts both tokens for the call', async () => {
    let capturedUrl = ''
    let capturedClientToken = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedClientToken = (init?.headers as Record<string, string>)['Client-Token']
        return jsonResponse({ messageId: 'z-1' })
      }),
    )
    const sendProvider = resolveSendProvider({
      provider: 'zapi',
      zapi_instance_id: 'inst-1',
      zapi_instance_token: encrypt('inst-token'),
      zapi_client_token: encrypt('client-token'),
    })
    expect(sendProvider.kind).toBe('zapi')
    const result = await sendProvider.sendText({ to: '5511999999999', text: 'hi' })
    expect(result.messageId).toBe('z-1')
    expect(capturedUrl).toBe('https://api.z-api.io/instances/inst-1/token/inst-token/send-text')
    expect(capturedClientToken).toBe('client-token')
  })

  it('throws when the Meta row is missing credentials', () => {
    expect(() => resolveSendProvider({ provider: 'meta' })).toThrow(
      'Meta connection is missing required credentials.',
    )
  })

  it('throws when the Z-API row is missing credentials', () => {
    expect(() =>
      resolveSendProvider({ provider: 'zapi', zapi_instance_id: 'inst-1' }),
    ).toThrow('Z-API connection is missing required credentials.')
  })

  describe('sendTemplate', () => {
    it('Meta: forwards template/params to the Cloud API and ignores renderedText', async () => {
      let capturedBody: Record<string, unknown> = {}
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(init?.body as string)
          return jsonResponse({ messages: [{ id: 'wamid.3' }] })
        }),
      )
      const sendProvider = resolveSendProvider({
        provider: 'meta',
        phone_number_id: '1234567890',
        access_token: encrypt('tok'),
      })
      await sendProvider.sendTemplate({
        to: '5511999999999',
        templateName: 'welcome',
        language: 'en_US',
        params: ['Ana'],
        renderedText: null,
      })
      expect(capturedBody.type).toBe('template')
      expect((capturedBody.template as { name: string }).name).toBe('welcome')
    })

    it('Z-API: sends the pre-rendered body as plain text', async () => {
      let capturedBody: Record<string, unknown> = {}
      let capturedUrl = ''
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          capturedUrl = url
          capturedBody = JSON.parse(init?.body as string)
          return jsonResponse({ messageId: 'z-2' })
        }),
      )
      const sendProvider = resolveSendProvider({
        provider: 'zapi',
        zapi_instance_id: 'inst-1',
        zapi_instance_token: encrypt('itok'),
        zapi_client_token: encrypt('ctok'),
      })
      await sendProvider.sendTemplate({
        to: '5511999999999',
        templateName: 'welcome',
        language: 'en_US',
        params: ['Ana'],
        renderedText: 'Welcome, Ana!',
      })
      expect(capturedUrl).toContain('/send-text')
      expect(capturedBody).toEqual({ phone: '5511999999999', message: 'Welcome, Ana!' })
    })

    it('Z-API: throws instead of sending a blank message when no renderedText is given', async () => {
      const sendProvider = resolveSendProvider({
        provider: 'zapi',
        zapi_instance_id: 'inst-1',
        zapi_instance_token: encrypt('itok'),
        zapi_client_token: encrypt('ctok'),
      })
      await expect(
        sendProvider.sendTemplate({
          to: '5511999999999',
          templateName: 'welcome',
          language: 'en_US',
          renderedText: null,
        }),
      ).rejects.toThrow('no rendered template body was provided')
    })
  })

  describe('sendReaction', () => {
    it('Meta: posts a reaction message to the Cloud API', async () => {
      let capturedBody: Record<string, unknown> = {}
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(init?.body as string)
          return jsonResponse({ messages: [{ id: 'wamid.4' }] })
        }),
      )
      const sendProvider = resolveSendProvider({
        provider: 'meta',
        phone_number_id: '1234567890',
        access_token: encrypt('tok'),
      })
      const result = await sendProvider.sendReaction({
        to: '5511999999999',
        targetMessageId: 'wamid.1',
        emoji: '👍',
      })
      expect(result.messageId).toBe('wamid.4')
      expect(capturedBody.type).toBe('reaction')
      expect(capturedBody.reaction).toEqual({ message_id: 'wamid.1', emoji: '👍' })
    })

    it('Z-API: posts to send-reaction with the target message id', async () => {
      let capturedUrl = ''
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          capturedUrl = url
          return jsonResponse({ messageId: 'z-react' })
        }),
      )
      const sendProvider = resolveSendProvider({
        provider: 'zapi',
        zapi_instance_id: 'inst-1',
        zapi_instance_token: encrypt('itok'),
        zapi_client_token: encrypt('ctok'),
      })
      const result = await sendProvider.sendReaction({
        to: '5511999999999',
        targetMessageId: 'z-msg-1',
        emoji: '👍',
      })
      expect(result.messageId).toBe('z-react')
      expect(capturedUrl).toContain('/send-reaction')
    })
  })
})
