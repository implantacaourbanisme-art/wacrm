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

export interface HandoffInput {
  phone: string
  name: string | null
  summary: string
  assignToEmail: string | null
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
  return { ok: true, value: { phone, name, summary, assignToEmail } }
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
  if (input.assignToEmail) {
    const { data: profile } = await db
      .from('profiles')
      .select('user_id, email')
      .eq('account_id', accountId)
      .ilike('email', escapeLike(input.assignToEmail))
      .maybeSingle()
    if (profile?.user_id) {
      assignedTo = { userId: profile.user_id as string, email: profile.email as string }
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
      user_id: authorId,
      note_text: `🚨 Transbordo — resumo do bot\n\n${input.summary}`,
    })
    .select('id')
    .single()
  if (noteError) console.error('[handoff] note insert failed:', noteError.message)

  return {
    conversationId: resolved.conversationId,
    contactId: resolved.contactId,
    contactCreated: resolved.contactCreated,
    assignedTo,
    noteId: (note?.id as string | undefined) ?? null,
  }
}
