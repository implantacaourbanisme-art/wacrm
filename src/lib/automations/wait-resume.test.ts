// ============================================================
// Regression test for the condition→wait finalize bug: a run whose
// `wait` step sits inside a `condition` branch used to have its log
// status flipped to 'success' the instant the top-level step sequence
// finished — before the waited-for step had actually run — because
// only the outermost scope's own (unaware of the nested branch)
// result decided the log's terminal status. This exercises the real
// dispatch → wait → cron-resume lifecycle end to end against a
// purpose-built in-memory DB, rather than mocking executeStepsFrom's
// internals directly, so it catches the bug the way it actually
// manifested: through automation_logs.status after each phase.
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

interface StepRow {
  id: string
  automation_id: string
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  position: number
  step_type: string
  step_config: Record<string, unknown>
}

const h = vi.hoisted(() => ({
  state: {
    automation: null as Record<string, unknown> | null,
    steps: [] as StepRow[],
    logs: new Map<string, Record<string, unknown>>(),
    pending: [] as Record<string, unknown>[],
    nextLogId: 1,
    nextPendingId: 1,
  },
}))

vi.mock('./admin-client', () => {
  const { state } = h

  function builder(table: string) {
    const ops: {
      type: string
      payload?: unknown
      eq: [string, unknown][]
      countMode: boolean
    } = { type: 'select', eq: [], countMode: false }

    const resolveSelect = () => {
      if (table === 'automations') {
        return { data: state.automation ? [state.automation] : [], error: null }
      }
      if (table === 'contacts') {
        return { data: { id: 'contact-1' }, error: null }
      }
      if (table === 'automation_steps') {
        const parentFilter = ops.eq.find(([k]) => k === 'parent_step_id')
        const branchFilter = ops.eq.find(([k]) => k === 'branch')
        const positionFilter = ops.eq.find(([k]) => k === '__gte_position')
        const rows = state.steps.filter((s) => {
          if (parentFilter && s.parent_step_id !== parentFilter[1]) return false
          if (branchFilter && s.branch !== branchFilter[1]) return false
          if (positionFilter && s.position < (positionFilter[1] as number)) return false
          return true
        })
        return { data: rows.sort((a, b) => a.position - b.position), error: null }
      }
      if (table === 'automation_logs') {
        const idFilter = ops.eq.find(([k]) => k === 'id')
        const row = idFilter ? state.logs.get(idFilter[1] as string) : undefined
        return { data: row ?? null, error: null }
      }
      if (table === 'automation_pending_executions') {
        if (ops.countMode) {
          const logIdFilter = ops.eq.find(([k]) => k === 'log_id')
          const statusFilter = ops.eq.find(([k]) => k === 'status')
          const count = state.pending.filter(
            (p) =>
              (!logIdFilter || p.log_id === logIdFilter[1]) &&
              (!statusFilter || p.status === statusFilter[1]),
          ).length
          return { data: null, error: null, count }
        }
        return { data: state.pending, error: null }
      }
      return { data: null, error: null }
    }

    const b: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count) ops.countMode = true
        return b
      },
      insert: (payload: unknown) => {
        ops.type = 'insert'
        ops.payload = payload
        if (table === 'automation_logs') {
          const id = `log-${state.nextLogId++}`
          const row = { id, ...(payload as Record<string, unknown>) }
          state.logs.set(id, row)
          ;(b as { _insertedRow?: unknown })._insertedRow = row
        }
        if (table === 'automation_pending_executions') {
          const id = `pending-${state.nextPendingId++}`
          state.pending.push({ id, ...(payload as Record<string, unknown>) })
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
      gte: (k: string, v: unknown) => {
        ops.eq.push([`__gte_${k}`, v])
        return b
      },
      is: (k: string, v: unknown) => {
        ops.eq.push([k, v])
        return b
      },
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(applyMutation() ?? resolveSelect()),
      maybeSingle: () => Promise.resolve(applyMutation() ?? resolveSelect()),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(applyMutation() ?? resolveSelect()).then(onF, onR),
    }

    function applyMutation(): { data: unknown; error: null } | undefined {
      if (ops.type === 'update') {
        const idFilter = ops.eq.find(([k]) => k === 'id')
        if (table === 'automation_logs' && idFilter) {
          const existing = state.logs.get(idFilter[1] as string) ?? {}
          state.logs.set(idFilter[1] as string, {
            ...existing,
            ...(ops.payload as Record<string, unknown>),
          })
        }
        if (table === 'automation_pending_executions' && idFilter) {
          const row = state.pending.find((p) => p.id === idFilter[1])
          if (row) Object.assign(row, ops.payload as Record<string, unknown>)
        }
        return { data: null, error: null }
      }
      if (ops.type === 'insert') {
        if (table === 'automation_logs') {
          return { data: (b as { _insertedRow?: unknown })._insertedRow, error: null }
        }
        return { data: null, error: null }
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
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'wamid-followup' })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'wamid-followup' })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: 'wamid-followup' })),
}))

import { runAutomationsForTrigger, resumePendingExecution } from './engine'

const ACCOUNT = 'acct-1'
const AUTOMATION_ID = 'auto-1'
const CONDITION_ID = 'step-condition'

beforeEach(() => {
  h.state.automation = {
    id: AUTOMATION_ID,
    account_id: ACCOUNT,
    user_id: 'user-1',
    trigger_type: 'keyword_match',
    trigger_config: { keywords: ['vip'], match_type: 'contains' },
    is_active: true,
  }
  h.state.steps = [
    {
      id: CONDITION_ID,
      automation_id: AUTOMATION_ID,
      parent_step_id: null,
      branch: null,
      position: 0,
      step_type: 'condition',
      step_config: { subject: 'message_content', operator: 'contains', value: 'vip' },
    },
    {
      id: 'step-wait',
      automation_id: AUTOMATION_ID,
      parent_step_id: CONDITION_ID,
      branch: 'yes',
      position: 0,
      step_type: 'wait',
      step_config: { amount: 1, unit: 'hours' },
    },
    {
      id: 'step-followup',
      automation_id: AUTOMATION_ID,
      parent_step_id: CONDITION_ID,
      branch: 'yes',
      position: 1,
      step_type: 'send_message',
      step_config: { text: 'Following up on your VIP request!' },
    },
  ]
  h.state.logs = new Map()
  h.state.pending = []
  h.state.nextLogId = 1
  h.state.nextPendingId = 1
})

describe('condition → wait → resume: automation_logs.status lifecycle', () => {
  it('stays partial after the initial dispatch enqueues the wait — not prematurely success', async () => {
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'keyword_match',
      contactId: 'contact-1',
      context: { message_text: 'I am a vip customer', conversation_id: 'conv-1' },
    })

    expect(h.state.logs.size).toBe(1)
    const log = [...h.state.logs.values()][0]
    // This is the bug: before the fix, the top-level scope's own
    // finalize call unconditionally overwrote this back to 'success'
    // the moment its loop finished, even though the branch it just
    // recursed into was still parked at the wait.
    expect(log.status).toBe('partial')
    expect(h.state.pending).toHaveLength(1)
    expect(h.state.pending[0]).toMatchObject({
      parent_step_id: CONDITION_ID,
      branch: 'yes',
      next_step_position: 1,
      status: 'pending',
    })
  })

  it('finalizes to success once the cron resumes past the wait', async () => {
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'keyword_match',
      contactId: 'contact-1',
      context: { message_text: 'I am a vip customer', conversation_id: 'conv-1' },
    })
    const logId = [...h.state.logs.keys()][0]
    const pendingRow = h.state.pending[0]

    await resumePendingExecution({
      id: pendingRow.id as string,
      automation_id: AUTOMATION_ID,
      user_id: 'user-1',
      account_id: ACCOUNT,
      contact_id: 'contact-1',
      log_id: logId,
      parent_step_id: pendingRow.parent_step_id as string,
      branch: pendingRow.branch as 'yes',
      next_step_position: pendingRow.next_step_position as number,
      context: pendingRow.context as never,
    })

    const log = h.state.logs.get(logId)!
    expect(log.status).toBe('success')
    expect(pendingRow.status).toBe('done')
  })

  it('does not resurrect a log a different branch already failed', async () => {
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'keyword_match',
      contactId: 'contact-1',
      context: { message_text: 'I am a vip customer', conversation_id: 'conv-1' },
    })
    const logId = [...h.state.logs.keys()][0]
    const pendingRow = h.state.pending[0]

    // Simulate a sibling branch having already failed this same log
    // (e.g. another top-level step threw before this resume runs).
    h.state.logs.set(logId, { ...h.state.logs.get(logId), status: 'failed' })

    await resumePendingExecution({
      id: pendingRow.id as string,
      automation_id: AUTOMATION_ID,
      user_id: 'user-1',
      account_id: ACCOUNT,
      contact_id: 'contact-1',
      log_id: logId,
      parent_step_id: pendingRow.parent_step_id as string,
      branch: pendingRow.branch as 'yes',
      next_step_position: pendingRow.next_step_position as number,
      context: pendingRow.context as never,
    })

    // The resumed branch itself succeeded, but 'failed' is terminal —
    // it must not be overwritten back to 'success'.
    expect(h.state.logs.get(logId)!.status).toBe('failed')
  })
})
