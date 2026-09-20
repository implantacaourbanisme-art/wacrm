// src/lib/conversations/handoff.ts
// ============================================================
// Handoff: an external system (the n8n bot's "Transbordo") hands a
// customer conversation to a human. Finds/creates the contact +
// conversation, assigns it to the agent with the given e-mail (if that
// person is a member of the account), reopens the thread and stores
// the bot's summary as a contact note.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { assignConversation } from '@/lib/conversations/assign'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

export const MAX_HANDOFF_SUMMARY_CHARS = 10000
export const MAX_DEAL_TITLE_CHARS = 200

export interface HandoffInput {
  phone: string
  name: string | null
  summary: string
  assignToEmail: string | null
  createDeal: boolean
  dealTitle: string | null
}

export type ParsedHandoff =
  | { ok: true; value: HandoffInput }
  | { ok: false; message: string }

export interface HandoffResult {
  conversationId: string
  contactId: string
  contactCreated: boolean
  assignedTo: { userId: string; email: string } | null
  noteId: string | null
  deal: { id: string; created: boolean } | null
}

export function parseHandoffBody(body: unknown): ParsedHandoff {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'Request body must be a JSON object' }
  }
  const b = body as Record<string, unknown>
  const phone = typeof b.phone === 'string' ? b.phone.trim() : ''
  if (!phone) return { ok: false, message: "'phone' is required" }
  const summary = typeof b.summary === 'string' ? b.summary.trim() : ''
  if (!summary) return { ok: false, message: "'summary' is required" }
  if (summary.length > MAX_HANDOFF_SUMMARY_CHARS) {
    return {
      ok: false,
      message: `'summary' must be at most ${MAX_HANDOFF_SUMMARY_CHARS} characters`,
    }
  }
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null
  const assignToEmail =
    typeof b.assign_to_email === 'string' && b.assign_to_email.trim()
      ? b.assign_to_email.trim().toLowerCase()
      : null
  if (assignToEmail?.includes('*')) {
    return { ok: false, message: "'assign_to_email' must not contain '*'" }
  }
  const createDeal = b.create_deal === true
  const dealTitle =
    typeof b.deal_title === 'string' && b.deal_title.trim()
      ? b.deal_title.trim().slice(0, MAX_DEAL_TITLE_CHARS)
      : null
  return { ok: true, value: { phone, name, summary, assignToEmail, createDeal, dealTitle } }
}

/** Escape LIKE wildcards so an e-mail is matched literally (case-insensitively). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

export async function performHandoff(
  db: SupabaseClient,
  accountId: string,
  input: HandoffInput
): Promise<HandoffResult> {
  const resolved = await resolveConversationByPhone(db, accountId, input.phone, input.name)

  let assignedTo: { userId: string; email: string } | null = null
  let assignedProfileId: string | null = null
  if (input.assignToEmail) {
    const { data: profile } = await db
      .from('profiles')
      .select('id, user_id, email')
      .eq('account_id', accountId)
      .ilike('email', escapeLike(input.assignToEmail))
      .maybeSingle()
    if (profile?.user_id) {
      assignedTo = { userId: profile.user_id as string, email: profile.email as string }
      assignedProfileId = (profile.id as string | undefined) ?? null
    } else {
      console.warn(
        '[handoff] no account member with e-mail',
        input.assignToEmail,
        '— leaving the conversation unassigned'
      )
    }
  }

  if (assignedTo) {
    const assigned = await assignConversation(db, {
      conversationId: resolved.conversationId,
      accountId,
      agentId: assignedTo.userId,
    })
    if (assigned.error) {
      console.error('[handoff] assignConversation failed:', assigned.error)
      assignedTo = null
      assignedProfileId = null
    }
  }

  // The thread must be visible to the agent: reopen it if it was closed.
  const { error: reopenError } = await db
    .from('conversations')
    .update({ status: 'open', updated_at: new Date().toISOString() })
    .eq('id', resolved.conversationId)
    .eq('account_id', accountId)
  if (reopenError) console.error('[handoff] reopen failed:', reopenError.message)

  const authorId = assignedTo?.userId ?? (await resolveAuditUserId(db, accountId))
  const { data: note, error: noteError } = await db
    .from('contact_notes')
    .insert({
      contact_id: resolved.contactId,
      account_id: accountId,
      user_id: authorId,
      note_text: `🚨 Transbordo — resumo do bot\n\n${input.summary}`,
    })
    .select('id')
    .single()
  if (noteError) console.error('[handoff] note insert failed:', noteError.message)

  const deal = input.createDeal
    ? await ensureDeal(db, accountId, {
        contactId: resolved.contactId,
        conversationId: resolved.conversationId,
        userId: authorId,
        assignedProfileId,
        title: input.dealTitle ?? `Lead — ${input.name ?? input.phone}`,
        notes: input.summary,
      })
    : null

  return {
    conversationId: resolved.conversationId,
    contactId: resolved.contactId,
    contactCreated: resolved.contactCreated,
    assignedTo,
    noteId: (note?.id as string | undefined) ?? null,
    deal,
  }
}

/**
 * Opens (or reuses) a sales deal for the contact in the account's first
 * pipeline / first stage. Never throws: any failure yields null so the
 * handoff itself still succeeds.
 */
async function ensureDeal(
  db: SupabaseClient,
  accountId: string,
  ctx: {
    contactId: string
    conversationId: string
    userId: string
    assignedProfileId: string | null
    title: string
    notes: string
  }
): Promise<{ id: string; created: boolean } | null> {
  try {
    const { data: pipeline, error: pipelineError } = await db
      .from('pipelines')
      .select('id')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (pipelineError) throw new Error(pipelineError.message)
    if (!pipeline?.id) {
      console.warn('[handoff] no pipeline in account — skipping deal creation')
      return null
    }
    const { data: stage, error: stageError } = await db
      .from('pipeline_stages')
      .select('id')
      .eq('pipeline_id', pipeline.id)
      .order('position', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (stageError) throw new Error(stageError.message)
    if (!stage?.id) {
      console.warn('[handoff] pipeline has no stages — skipping deal creation')
      return null
    }

    const findOpenDeal = () =>
      db
        .from('deals')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', ctx.contactId)
        .eq('pipeline_id', pipeline.id)
        .eq('status', 'open')
        .limit(1)
        .maybeSingle()
    const { data: existing, error: existingError } = await findOpenDeal()
    if (existingError) throw new Error(existingError.message)
    if (existing?.id) return { id: existing.id as string, created: false }

    const { data: acct } = await db
      .from('accounts')
      .select('default_currency')
      .eq('id', accountId)
      .maybeSingle()
    const currency = (acct?.default_currency as string | null | undefined) ?? 'BRL'

    const { data: deal, error: dealError } = await db
      .from('deals')
      .insert({
        account_id: accountId,
        user_id: ctx.userId,
        pipeline_id: pipeline.id,
        stage_id: stage.id,
        contact_id: ctx.contactId,
        conversation_id: ctx.conversationId,
        title: ctx.title,
        value: 0,
        currency,
        status: 'open',
        assigned_to: ctx.assignedProfileId,
        notes: ctx.notes,
      })
      .select('id')
      .single()
    if (dealError || !deal?.id) {
      // Possibly lost a race with a concurrent handoff: reuse the open deal if one exists now.
      const { data: raced } = await findOpenDeal()
      if (raced?.id) return { id: raced.id as string, created: false }
      throw new Error(dealError?.message ?? 'no row returned')
    }
    return { id: deal.id as string, created: true }
  } catch (err) {
    console.error('[handoff] deal creation failed:', err instanceof Error ? err.message : err)
    return null
  }
}
