// ============================================================
// Regression test: `conversation_assigned` was fully buildable and
// activatable in the automation builder UI, but nothing in the
// codebase ever dispatched it — an automation listening for it never
// fired, silently, forever. This exercises the real path: an
// `assign_conversation` step changes the assignment, which should
// fire `conversation_assigned` for a second automation to react to.
//
// Also covers the chain-depth guard: two automations that each
// reassign the conversation in response to the other's
// conversation_assigned trigger would loop forever without a cap.
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

interface AutomationRow {
  id: string
  account_id: string
  user_id: string
  trigger_type: string
  trigger_config?: Record<string, unknown>
  is_active: boolean
}

const h = vi.hoisted(() => ({
  state: {
    automations: [] as AutomationRow[],
    // automation_id -> its steps (all top-level, no branches needed here)
    steps: {} as Record<string, Array<{ id: string; step_type: string; step_config: Record<string, unknown>; position: number }>>,
    conversations: new Map<string, { id: string; contact_id: string; assigned_agent_id: string | null }>(),
    logs: [] as Record<string, unknown>[],
  },
}))

vi.mock('./admin-client', () => {
  const { state } = h

  function builder(table: string) {
    const ops: { type: string; payload?: unknown; eq: [string, unknown][] } = {
      type: 'select',
      eq: [],
    }

    const resolveSelect = () => {
      if (table === 'automations') {
        const accId = ops.eq.find(([k]) => k === 'account_id')?.[1]
        const trigger = ops.eq.find(([k]) => k === 'trigger_type')?.[1]
        const rows = state.automations.filter(
          (a) => a.account_id === accId && a.trigger_type === trigger && a.is_active,
        )
        return { data: rows, error: null }
      }
      if (table === 'automation_steps') {
        const autoId = ops.eq.find(([k]) => k === 'automation_id')?.[1] as string
        const rows = (state.steps[autoId] ?? []).map((s) => ({
          ...s,
          automation_id: autoId,
          parent_step_id: null,
          branch: null,
        }))
        return { data: rows.sort((a, b) => a.position - b.position), error: null }
      }
      if (table === 'contacts') {
        return { data: { id: 'contact-1' }, error: null }
      }
      return { data: null, error: null }
    }

    const b: Record<string, unknown> = {
      select: () => b,
      insert: (payload: unknown) => {
        ops.type = 'insert'
        ops.payload = payload
        if (table === 'automation_logs') {
          const row = { id: `log-${state.logs.length + 1}`, ...(payload as Record<string, unknown>) }
          state.logs.push(row)
          ;(b as { _row?: unknown })._row = row
        }
        return b
      },
      update: (payload: unknown) => {
        ops.type = 'update'
        ops.payload = payload
        return b
      },
      eq: (k: string, v: unknown) => {
        ops.eq.push([k, v])
        return b
      },
      is: () => b,
      gte: () => b,
      order: () => b,
      limit: () => Promise.resolve(resolveSelect()),
      single: () => Promise.resolve(applyMutation() ?? resolveSelect()),
      maybeSingle: () => Promise.resolve(applyMutation() ?? resolveSelect()),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(applyMutation() ?? resolveSelect()).then(onF, onR),
    }

    function applyMutation(): { data: unknown; error: null } | undefined {
      if (ops.type === 'update' && table === 'conversations') {
        const contactId = ops.eq.find(([k]) => k === 'contact_id')?.[1] as string
        const conv = [...state.conversations.values()].find((c) => c.contact_id === contactId)
        if (conv) {
          Object.assign(conv, ops.payload as Record<string, unknown>)
          return { data: { id: conv.id }, error: null }
        }
        return { data: null, error: null }
      }
      if (ops.type === 'insert' && table === 'automation_logs') {
        return { data: (b as { _row?: unknown })._row, error: null }
      }
      return undefined
    }

    return b
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ error: null }),
    }),
  }
})

vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
}))

import { runAutomationsForTrigger, triggerMatches } from './engine'

const ACCOUNT = 'acct-1'

beforeEach(() => {
  h.state.automations = []
  h.state.steps = {}
  h.state.conversations = new Map([
    ['conv-1', { id: 'conv-1', contact_id: 'contact-1', assigned_agent_id: null }],
  ])
  h.state.logs = []
})

// triggerMatches gates keyword/tag/interactive triggers on config, but
// conversation_assigned has no such config to match — confirm the
// dispatcher treats an active, right-trigger-type automation as a
// match unconditionally (mirrors new_contact_created's own shape).
describe('triggerMatches — conversation_assigned', () => {
  it('matches any active automation for the trigger type, no extra config needed', () => {
    const automation = {
      id: 'a',
      trigger_type: 'conversation_assigned',
    } as never
    expect(triggerMatches(automation, { conversation_id: 'conv-1', agent_id: 'agent-1' })).toBe(true)
  })
})

describe('assign_conversation step dispatches conversation_assigned', () => {
  it('a second automation listening for conversation_assigned actually fires', async () => {
    h.state.automations = [
      {
        id: 'auto-assigner',
        account_id: ACCOUNT,
        user_id: 'user-1',
        trigger_type: 'new_message_received',
        is_active: true,
      },
      {
        id: 'auto-notifier',
        account_id: ACCOUNT,
        user_id: 'user-1',
        trigger_type: 'conversation_assigned',
        is_active: true,
      },
    ]
    h.state.steps['auto-assigner'] = [
      {
        id: 'step-assign',
        step_type: 'assign_conversation',
        step_config: { mode: 'specific', agent_id: 'agent-9' },
        position: 0,
      },
    ]
    // The notifier automation has no steps configured — its dispatch
    // firing at all (proven by the log insert below) is what this
    // test is actually checking.
    h.state.steps['auto-notifier'] = []

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'contact-1',
      context: { conversation_id: 'conv-1' },
    })

    expect(h.state.conversations.get('conv-1')?.assigned_agent_id).toBe('agent-9')
    // Two automation_logs rows: one for the assigner, one for the
    // notifier that conversation_assigned dispatched into.
    const triggers = h.state.logs.map((l) => l.trigger_event)
    expect(triggers).toContain('new_message_received')
    expect(triggers).toContain('conversation_assigned')
  })

  it('the chain depth cap stops two automations from reassigning each other forever', async () => {
    // Both automations react to conversation_assigned by reassigning —
    // without the depth cap this recurses until the stack overflows.
    h.state.automations = [
      {
        id: 'auto-ping',
        account_id: ACCOUNT,
        user_id: 'user-1',
        trigger_type: 'conversation_assigned',
        is_active: true,
      },
    ]
    h.state.steps['auto-ping'] = [
      {
        id: 'step-reassign',
        step_type: 'assign_conversation',
        step_config: { mode: 'specific', agent_id: 'agent-ping' },
        position: 0,
      },
    ]

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'conversation_assigned',
      contactId: 'contact-1',
      context: { conversation_id: 'conv-1', agent_id: 'agent-seed' },
    })

    // MAX_CONVERSATION_ASSIGN_CHAIN_DEPTH is 3 — the seed dispatch is
    // depth 0, so it re-fires 3 more times (depths 1, 2, 3) before the
    // guard at depth 3 refuses to dispatch again. That's 4 total log
    // rows for this trigger chain, not an unbounded number.
    const triggers = h.state.logs.filter((l) => l.trigger_event === 'conversation_assigned')
    expect(triggers.length).toBeLessThanOrEqual(4)
    expect(triggers.length).toBeGreaterThan(0)
  })
})
