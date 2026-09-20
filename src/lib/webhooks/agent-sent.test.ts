/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn(async () => {}),
}))

import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { notifyAgentMessageSent, phoneDigits } from './agent-sent'

let row: any
let shouldThrow = false
const db: any = {
  from() {
    const proxy: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (res: any, rej: any) => {
            if (shouldThrow) return Promise.reject(new Error('db down')).then(res, rej)
            return Promise.resolve({ data: row, error: null }).then(res, rej)
          }
        }
        return () => proxy
      },
    })
    return proxy
  },
}
const args = { conversationId: 'conv1', messageId: 'm1', whatsappMessageId: 'wamid1', text: 'Olá, sou o Alisson' }

beforeEach(() => {
  vi.mocked(dispatchWebhookEvent).mockClear()
  row = { contact_id: 'c1', contacts: { phone: '+55 82 99600-4382' } }
  shouldThrow = false
})

describe('phoneDigits', () => {
  it('keeps only digits', () => {
    expect(phoneDigits('+55 (82) 99600-4382')).toBe('5582996004382')
    expect(phoneDigits(null)).toBe('')
  })
})

describe('notifyAgentMessageSent', () => {
  it('dispatches message.sent with a digits-only phone', async () => {
    await notifyAgentMessageSent(db, 'acc1', args)
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(db, 'acc1', 'message.sent', {
      conversation_id: 'conv1',
      contact_id: 'c1',
      phone: '5582996004382',
      message_id: 'm1',
      whatsapp_message_id: 'wamid1',
      text: 'Olá, sou o Alisson',
    })
  })

  it('accepts the contacts relation as an array', async () => {
    row = { contact_id: 'c1', contacts: [{ phone: '5582996004382' }] }
    await notifyAgentMessageSent(db, 'acc1', args)
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the conversation or phone is missing', async () => {
    row = null
    await notifyAgentMessageSent(db, 'acc1', args)
    row = { contact_id: 'c1', contacts: { phone: null } }
    await notifyAgentMessageSent(db, 'acc1', args)
    expect(dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    shouldThrow = true
    await expect(notifyAgentMessageSent(db, 'acc1', args)).resolves.toBeUndefined()
  })
})
