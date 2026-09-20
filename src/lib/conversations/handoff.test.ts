// src/lib/conversations/handoff.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  profile: null as null | { id?: string; user_id: string; email: string },
  pipeline: null as null | { id: string },
  stage: null as null | { id: string },
  existingDeal: null as null | { id: string },
  deals: [] as Record<string, unknown>[],
  tablesTouched: [] as string[],
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
      h.tablesTouched.push(table)
      const result = () => {
        if (table === 'pipelines') return { data: h.pipeline, error: null }
        if (table === 'pipeline_stages') return { data: h.stage, error: null }
        if (table === 'deals' && op === 'insert') {
          h.deals.push(payload as Record<string, unknown>)
          return { data: { id: 'deal1' }, error: null }
        }
        if (table === 'deals') return { data: h.existingDeal, error: null }
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
  createDeal: false,
  dealTitle: null,
}

beforeEach(() => {
  h.profile = null
  h.notes.length = 0
  h.convUpdates.length = 0
  h.ilikeArgs.length = 0
  h.pipeline = null
  h.stage = null
  h.existingDeal = null
  h.deals.length = 0
  h.tablesTouched.length = 0
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
      value: { phone: '+558296004382', name: 'Ana', summary: 'resumo', assignToEmail: 'a@b.com', createDeal: false, dealTitle: null },
    })
  })
  it('treats name and email as optional', () => {
    const r = parseHandoffBody({ phone: '5582', summary: 'x' })
    expect(r).toEqual({
      ok: true,
      value: { phone: '5582', name: null, summary: 'x', assignToEmail: null, createDeal: false, dealTitle: null },
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

describe('parseHandoffBody deal fields', () => {
  const base = { phone: '5582', summary: 'x' }
  it('parses create_deal true and a trimmed deal_title', () => {
    const r = parseHandoffBody({ ...base, create_deal: true, deal_title: ' Lead Ana ' })
    expect(r).toMatchObject({ ok: true, value: { createDeal: true, dealTitle: 'Lead Ana' } })
  })
  it('only true enables create_deal', () => {
    for (const v of [false, 'true', 1, undefined]) {
      const r = parseHandoffBody({ ...base, create_deal: v })
      expect(r).toMatchObject({ ok: true, value: { createDeal: false, dealTitle: null } })
    }
  })
  it('caps deal_title at 200 chars and ignores blank titles', () => {
    const r = parseHandoffBody({ ...base, create_deal: true, deal_title: 'x'.repeat(300) })
    expect(r.ok && r.value.dealTitle).toHaveLength(200)
    const b = parseHandoffBody({ ...base, deal_title: '   ' })
    expect(b).toMatchObject({ ok: true, value: { dealTitle: null } })
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
      deal: null,
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

  describe('deal creation', () => {
    const dealInput = { ...input, createDeal: true }
    beforeEach(() => {
      h.pipeline = { id: 'pipe1' }
      h.stage = { id: 'stage1' }
    })

    it('inserts a deal with the full payload in the first pipeline/stage', async () => {
      h.profile = { id: 'prof-alisson', user_id: 'user-alisson', email: 'joalyssoncleverton96@icloud.com' }
      const r = await performHandoff(makeDb(), 'acc1', dealInput)
      expect(h.deals).toHaveLength(1)
      expect(h.deals[0]).toEqual({
        account_id: 'acc1',
        user_id: 'user-alisson',
        pipeline_id: 'pipe1',
        stage_id: 'stage1',
        contact_id: 'c1',
        conversation_id: 'conv1',
        title: 'Lead — Cliente',
        value: 0,
        currency: 'BRL',
        status: 'open',
        assigned_to: 'prof-alisson',
        notes: 'Cliente quer 2ª via do boleto.',
      })
      expect(r.deal).toEqual({ id: 'deal1', created: true })
    })

    it('uses deal_title when given and the phone when there is no name', async () => {
      await performHandoff(makeDb(), 'acc1', { ...dealInput, dealTitle: 'Custom' })
      expect(h.deals[0]).toMatchObject({ title: 'Custom' })
      await performHandoff(makeDb(), 'acc1', { ...dealInput, name: null })
      expect(h.deals[1]).toMatchObject({ title: 'Lead — +558296004382' })
    })

    it('leaves assigned_to null when unassigned and uses the audit user', async () => {
      await performHandoff(makeDb(), 'acc1', dealInput)
      expect(h.deals[0]).toMatchObject({ assigned_to: null, user_id: 'owner1' })
    })

    it('reuses an existing open deal without inserting', async () => {
      h.existingDeal = { id: 'deal-old' }
      const r = await performHandoff(makeDb(), 'acc1', dealInput)
      expect(h.deals).toHaveLength(0)
      expect(r.deal).toEqual({ id: 'deal-old', created: false })
    })

    it('returns deal null and still succeeds when the account has no pipeline', async () => {
      h.pipeline = null
      const r = await performHandoff(makeDb(), 'acc1', dealInput)
      expect(r.deal).toBeNull()
      expect(r.noteId).toBe('note1')
      expect(h.deals).toHaveLength(0)
    })

    it('does not touch pipelines/deals when createDeal is false', async () => {
      const r = await performHandoff(makeDb(), 'acc1', input)
      expect(r.deal).toBeNull()
      expect(h.tablesTouched).not.toContain('deals')
      expect(h.tablesTouched).not.toContain('pipelines')
      expect(h.tablesTouched).not.toContain('pipeline_stages')
    })
  })
})
