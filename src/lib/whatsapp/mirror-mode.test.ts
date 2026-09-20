import { describe, expect, it } from 'vitest'
import {
  classifyZApiMessageEvent,
  isMirrorAuthMissing,
  isMirrorRequest,
  wantsSkipWebhookRegistration,
} from './mirror-mode'

describe('isMirrorRequest', () => {
  it('is true only for mirror=1', () => {
    expect(isMirrorRequest('https://x.test/api/whatsapp/zapi/webhook?mirror=1')).toBe(true)
    expect(isMirrorRequest('https://x.test/api/whatsapp/zapi/webhook?token=a&mirror=1')).toBe(true)
  })
  it('is false without the flag or with another value', () => {
    expect(isMirrorRequest('https://x.test/api/whatsapp/zapi/webhook')).toBe(false)
    expect(isMirrorRequest('https://x.test/api/whatsapp/zapi/webhook?mirror=0')).toBe(false)
    expect(isMirrorRequest('https://x.test/api/whatsapp/zapi/webhook?mirror=true')).toBe(false)
  })
  it('is false for an unparseable url', () => {
    expect(isMirrorRequest('not a url')).toBe(false)
  })
})

describe('classifyZApiMessageEvent', () => {
  it('ingests a normal inbound message', () => {
    expect(classifyZApiMessageEvent({}, false)).toBe('ingest_inbound')
    expect(classifyZApiMessageEvent({ fromMe: false }, true)).toBe('ingest_inbound')
  })
  it('skips fromMe echoes outside mirror mode (legacy behaviour)', () => {
    expect(classifyZApiMessageEvent({ fromMe: true }, false)).toBe('skip_outbound_echo')
  })
  it('ingests fromMe as outbound in mirror mode', () => {
    expect(classifyZApiMessageEvent({ fromMe: true }, true)).toBe('ingest_outbound')
  })
  it('always skips group traffic', () => {
    expect(classifyZApiMessageEvent({ isGroup: true }, false)).toBe('skip_group')
    expect(classifyZApiMessageEvent({ isGroup: true, fromMe: true }, true)).toBe('skip_group')
  })
})

describe('wantsSkipWebhookRegistration', () => {
  it('is true only for a boolean true flag', () => {
    expect(wantsSkipWebhookRegistration({ skip_webhook_registration: true })).toBe(true)
  })
  it('is false otherwise', () => {
    expect(wantsSkipWebhookRegistration({})).toBe(false)
    expect(wantsSkipWebhookRegistration({ skip_webhook_registration: 'true' })).toBe(false)
    expect(wantsSkipWebhookRegistration(null)).toBe(false)
    expect(wantsSkipWebhookRegistration('x')).toBe(false)
  })
})

describe('isMirrorAuthMissing', () => {
  it('is never missing outside mirror mode', () => {
    expect(isMirrorAuthMissing(false, null, null)).toBe(false)
    expect(isMirrorAuthMissing(false, '', undefined)).toBe(false)
    expect(isMirrorAuthMissing(false, 'a', 'b')).toBe(false)
  })
  it('is ok in mirror mode when both tokens are present', () => {
    expect(isMirrorAuthMissing(true, 'a', 'b')).toBe(false)
  })
  it('is missing in mirror mode when the supplied token is absent', () => {
    expect(isMirrorAuthMissing(true, null, 'b')).toBe(true)
    expect(isMirrorAuthMissing(true, '', 'b')).toBe(true)
  })
  it('is missing in mirror mode when no token is stored', () => {
    expect(isMirrorAuthMissing(true, 'a', null)).toBe(true)
    expect(isMirrorAuthMissing(true, 'a', undefined)).toBe(true)
    expect(isMirrorAuthMissing(true, 'a', '')).toBe(true)
  })
})
