/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  messageUpserts: [] as Record<string, unknown>[],
  convUpdates: [] as Record<string, unknown>[],
  rpcCalls: [] as { fn: string; args: unknown }[],
  upsertRows: [{ id: 'm1' }] as { id: string }[],
  convFilters: [] as string[],
}))

// Chainable, awaitable fake of the Supabase query builder: every method
// returns the builder, awaiting it yields a canned result per table/op.
vi.mock('@/lib/flows/admin-client', () => {
  function builder(table: string) {
    let op = 'select'
    let payload: unknown
    const result = () => {
      if (table === 'messages' && op === 'upsert') {
        h.messageUpserts.push(payload as Record<string, unknown>)
        return { data: h.upsertRows, error: null }
      }
      if (table === 'messages') return { data: null, count: 0, error: null }
      if (table === 'conversations' && op === 'update') {
        h.convUpdates.push(payload as Record<string, unknown>)
        return { data: null, error: null }
      }
      if (table === 'conversations') {
        return { data: [{ id: 'conv1', status: 'open' }], error: null }
      }
      return { data: null, error: null }
    }
    const proxy: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            return (res: any, rej: any) => Promise.resolve(result()).then(res, rej)
          }
          return (...args: unknown[]) => {
            if (table === 'conversations' && prop === 'or') h.convFilters.push(String(args[0]))
            if (['insert', 'update', 'upsert', 'delete'].includes(prop)) {
              op = prop
              payload = args[0]
            }
            return proxy
          }
        },
      }
    )
    return proxy
  }
  return {
    supabaseAdmin: () => ({
      from: builder,
      rpc: async (fn: string, args: unknown) => {
        h.rpcCalls.push({ fn, args })
        return { error: null }
      },
    }),
  }
})

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({
    id: 'contact1',
    name: 'Cliente',
    phone: '5582996004382',
  })),
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/conversations/reopen', () => ({
  reopenClosedConversation: vi.fn(async () => {}),
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(async () => {}),
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })),
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: vi.fn(async () => {}),
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn(async () => {}),
}))

import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { ingestInboundMessage } from './inbound-pipeline'

const base = {
  accountId: 'acc1',
  configOwnerUserId: 'user1',
  identity: {
    phone: '5582996004382',
    waUserId: null,
    waParentUserId: null,
    waUsername: null,
    name: '',
  },
  message: {
    providerMessageId: 'wamid-1',
    timestampMs: 1_700_000_000_000,
    contentType: 'text' as const,
    rawTypeLabel: 'text',
    contentText: 'Olá',
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  },
}

function expectNoDispatch() {
  expect(dispatchInboundToFlows).not.toHaveBeenCalled()
  expect(runAutomationsForTrigger).not.toHaveBeenCalled()
  expect(dispatchInboundToAiReply).not.toHaveBeenCalled()
  expect(dispatchWebhookEvent).not.toHaveBeenCalled()
}

beforeEach(() => {
  h.messageUpserts.length = 0
  h.convUpdates.length = 0
  h.rpcCalls.length = 0
  h.convFilters.length = 0
  h.upsertRows = [{ id: 'm1' }]
  vi.clearAllMocks()
})

describe('ingestInboundMessage — mirror mode', () => {
  it('inbound mirror: stores a customer message, bumps unread, dispatches nothing', async () => {
    await ingestInboundMessage({ ...base, mirror: { direction: 'inbound' } })

    expect(h.messageUpserts).toHaveLength(1)
    expect(h.messageUpserts[0]).toMatchObject({
      sender_type: 'customer',
      status: 'delivered',
      message_id: 'wamid-1',
      content_text: 'Olá',
    })
    expect(h.rpcCalls.map((c) => c.fn)).toEqual(['bump_conversation_on_inbound'])
    expectNoDispatch()
  })

  it('outbound mirror: stores a bot message, no unread bump, updates last message', async () => {
    await ingestInboundMessage({
      ...base,
      message: { ...base.message, providerMessageId: 'wamid-2', contentText: 'Oi! Sou o bot' },
      mirror: { direction: 'outbound' },
    })

    expect(h.messageUpserts[0]).toMatchObject({
      sender_type: 'bot',
      status: 'sent',
      message_id: 'wamid-2',
    })
    expect(h.rpcCalls).toHaveLength(0)
    expect(h.convUpdates).toHaveLength(1)
    expect(h.convUpdates[0]).toMatchObject({ last_message_text: 'Oi! Sou o bot' })
    expectNoDispatch()
  })

  it('outbound mirror: never moves last_message_at backwards (guarded update)', async () => {
    await ingestInboundMessage({ ...base, mirror: { direction: 'outbound' } })

    const iso = new Date(base.message.timestampMs).toISOString()
    expect(h.convFilters).toContain(`last_message_at.is.null,last_message_at.lt.${iso}`)
  })

  it('duplicate message id (upsert returns no rows): no conversation update, no bump, no dispatch', async () => {
    h.upsertRows = []
    await ingestInboundMessage({ ...base, mirror: { direction: 'outbound' } })
    await ingestInboundMessage({ ...base, mirror: { direction: 'inbound' } })

    expect(h.convUpdates).toHaveLength(0)
    expect(h.rpcCalls).toHaveLength(0)
    expectNoDispatch()
  })
})

describe('ingestInboundMessage — normal mode (regression)', () => {
  it('still stores a customer message and runs the dispatch chain', async () => {
    await ingestInboundMessage(base)

    expect(h.messageUpserts[0]).toMatchObject({ sender_type: 'customer', status: 'delivered' })
    expect(dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(dispatchInboundToAiReply).toHaveBeenCalledTimes(1)
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acc1',
      'message.received',
      expect.objectContaining({ conversation_id: 'conv1' })
    )
  })
})
