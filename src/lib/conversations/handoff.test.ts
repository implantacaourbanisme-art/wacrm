// src/lib/conversations/handoff.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  profile: null as null | { user_id: string; email: string },
  notes: [] as Record<string, unknown>[],
  convUpdates: [] as Record<string, unknown>[],
  ilikeArgs: [] as unknown[][],
}))

vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: vi.fn(async () => ({
    conversationId: 'conv1',
    contactId: 'c1',
    contactCreated: false,
  })),
}))
vi.mock('@/lib/conversations/assign', () => ({
  assignConversation: vi.fn(async () => ({ contactId: 'c1', error: null })),
}))
vi.mock('@/lib/api/v1/contacts', () => ({
  resolveAuditUserId: vi.fn(async () => 'owner1'),
}))

import { assignConversation } from '@/lib/conversations/assign'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { parseHandoffBody, performHandoff, MAX_HANDOFF_SUMMARY_CHARS } from './handoff'

function makeDb(): any {
  return {
    from(table: string) {
      let op = 'select'
      let payload: unknown
      const result = () => {
        if (table === 'profiles') return { data: h.profile, error: null }
        if (table === 'conversations' && op === 'update') {
          h.convUpdates.push(payload as Record<string, unknown>)
          return { data: null, error: null }
        }
        if (table === 'contact_notes' && op === 'insert') {
          h.notes.push(payload as Record<string, unknown>)
          return { data: { id: 'note1' }, error: null }
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
              if (['insert', 'update'].includes(prop)) {
                op = prop
                payload = args[0]
              }
              if (prop === 'ilike') h.ilikeArgs.push(args)
              return proxy
            }
          },
        }
      )
      return proxy
    },
  }
}

const input = {
  phone: '+558296004382',
  name: 'Cliente',
  summary: 'Cliente quer 2ª via do boleto.',
  assignToEmail: 'joalyssoncleverton96@icloud.com',
}

beforeEach(() => {
  h.profile = null
  h.notes.length = 0
  h.convUpdates.length = 0
  h.ilikeArgs.length = 0
})

describe('parseHandoffBody', () => {
  it('accepts a full body and normalizes fields', () => {
    const r = parseHandoffBody({
      phone: ' +558296004382 ',
      name: ' Ana ',
      summary: ' resumo ',
      assign_to_email: ' A@B.com ',
    })
    expect(r).toEqual({
      ok: true,
      value: { phone: '+558296004382', name: 'Ana', summary: 'resumo', assignToEmail: 'a@b.com' },
    })
  })
  it('treats name and email as optional', () => {
    const r = parseHandoffBody({ phone: '5582', summary: 'x' })
    expect(r).toEqual({
      ok: true,
      value: { phone: '5582', name: null, summary: 'x', assignToEmail: null },
    })
  })
  it('rejects a non-object body, a missing phone, a missing summary and an oversized summary', () => {
    expect(parseHandoffBody(null).ok).toBe(false)
    expect(parseHandoffBody({ summary: 'x' }).ok).toBe(false)
    expect(parseHandoffBody({ phone: '5582' }).ok).toBe(false)
    expect(
      parseHandoffBody({ phone: '5582', summary: 'x'.repeat(MAX_HANDOFF_SUMMARY_CHARS + 1) }).ok
    ).toBe(false)
  })
})

describe('parseHandoffBody wildcard guard', () => {
  it("rejects an assign_to_email containing '*'", () => {
    expect(parseHandoffBody({ phone: '5582', summary: 'x', assign_to_email: 'a*@b.com' })).toEqual({
      ok: false,
      message: "'assign_to_email' must not contain '*'",
    })
  })
})

describe('performHandoff', () => {
  it('assigns to the member found by email, reopens the thread and writes the note as that member', async () => {
    h.profile = { user_id: 'user-alisson', email: 'joalyssoncleverton96@icloud.com' }
    const r = await performHandoff(makeDb(), 'acc1', input)

    expect(resolveConversationByPhone).toHaveBeenCalledWith(
      expect.anything(), 'acc1', '+558296004382', 'Cliente'
    )
    expect(assignConversation).toHaveBeenCalledWith(expect.anything(), {
      conversationId: 'conv1',
      accountId: 'acc1',
      agentId: 'user-alisson',
    })
    expect(h.convUpdates[0]).toMatchObject({ status: 'open' })
    expect(h.notes[0]).toEqual({
      contact_id: 'c1',
      account_id: 'acc1',
      user_id: 'user-alisson',
      note_text: expect.stringContaining('Cliente quer 2ª via do boleto.'),
    })
    expect(r).toEqual({
      conversationId: 'conv1',
      contactId: 'c1',
      contactCreated: false,
      assignedTo: { userId: 'user-alisson', email: 'joalyssoncleverton96@icloud.com' },
      noteId: 'note1',
    })
  })

  it('leaves the conversation unassigned when no member has that email, note authored by the account owner', async () => {
    const r = await performHandoff(makeDb(), 'acc1', input)
    expect(assignConversation).not.toHaveBeenCalled()
    expect(r.assignedTo).toBeNull()
    expect(h.notes[0]).toEqual({
      contact_id: 'c1',
      account_id: 'acc1',
      user_id: 'owner1',
      note_text: expect.stringContaining('Cliente quer 2ª via do boleto.'),
    })
  })

  it('does not look anyone up when no email is given', async () => {
    const r = await performHandoff(makeDb(), 'acc1', { ...input, assignToEmail: null })
    expect(h.ilikeArgs).toHaveLength(0)
    expect(assignConversation).not.toHaveBeenCalled()
    expect(r.assignedTo).toBeNull()
  })

  it('escapes LIKE wildcards in the email lookup', async () => {
    await performHandoff(makeDb(), 'acc1', { ...input, assignToEmail: 'a_b%c@x.com' })
    expect(h.ilikeArgs[0]).toEqual(['email', 'a\\_b\\%c@x.com'])
  })

  it('falls back to unassigned (and owner-authored note) when assignConversation fails', async () => {
    h.profile = { user_id: 'user-alisson', email: 'joalyssoncleverton96@icloud.com' }
    vi.mocked(assignConversation).mockResolvedValueOnce({ contactId: null, error: 'boom' })
    const r = await performHandoff(makeDb(), 'acc1', input)
    expect(r.assignedTo).toBeNull()
    expect(h.notes[0]).toMatchObject({ user_id: 'owner1' })
  })
})
