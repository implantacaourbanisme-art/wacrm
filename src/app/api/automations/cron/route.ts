import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution, runAutomationsForTrigger } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { cronMatchedInWindow } from '@/lib/automations/cron-matches'
import type { TimeBasedTriggerConfig } from '@/types'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  // ── time_based automations ──────────────────────────────────────────────
  // Sweep all active time_based automations for this invocation window.
  // The endpoint is called once per minute (or more); 65 s gives a margin
  // for slight invocation drift without risk of double-firing a 1-min cron.
  //
  // time_based fires without a contactId — steps that require a contact
  // (send_message, send_template, …) will surface a clear error in the log
  // rather than silently not running. Callers that need per-contact blasts
  // should use the Broadcasts module instead.
  {
    const now = new Date()
    const { data: timeAutomations } = await admin
      .from('automations')
      .select('id, account_id, trigger_config')
      .eq('trigger_type', 'time_based')
      .eq('is_active', true)

    for (const auto of timeAutomations ?? []) {
      const cfg = auto.trigger_config as TimeBasedTriggerConfig | null
      if (!cfg?.schedule) continue
      if (!cronMatchedInWindow(cfg.schedule, 65_000, now)) continue
      // Fire-and-forget, matching how webhook-triggered automations are
      // dispatched. Failures are caught and logged inside the engine.
      await runAutomationsForTrigger({
        accountId: auto.account_id as string,
        triggerType: 'time_based',
        contactId: null,
      }).catch((err) =>
        console.error('[automations/cron] time_based dispatch failed:', auto.id, err),
      )
    }
  }

  // ── pending wait-step executions ────────────────────────────────────────
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })


  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  return NextResponse.json({ processed })
}
