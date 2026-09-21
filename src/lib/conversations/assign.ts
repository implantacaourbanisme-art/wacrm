import type { SupabaseClient } from '@supabase/supabase-js'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import {
  MAX_CONVERSATION_ASSIGN_CHAIN_DEPTH,
  getConversationAssignChainDepth,
} from '@/lib/conversations/assign-chain'
import type { AutomationContext } from '@/lib/automations/engine'

// ============================================================
// Conversation assignment — the ONE place that fires the
// `conversation_assigned` automation trigger.
//
// Several independent call sites change `conversations.assigned_agent_id`
// (the manual inbox dropdown, the AI take-over/resume banner, the AI
// auto-handoff path, the automations engine's own assign_conversation
// step, and the flows engine's handoff node). `conversation_assigned`
// was fully buildable and activatable as an automation trigger in the
// builder UI, but nothing dispatched it — a customer who built "when
// assigned, notify the team" got no error, the automation just never
// fired, silently, forever.
//
// `dispatchConversationAssignedTrigger` is the fix: every call site
// that changes the assignment calls it afterward (either directly, for
// a site whose own UPDATE has to stay combined with other columns —
// see flows/engine.ts's executeHandoff — or via `assignConversation`
// below, the convenience wrapper for sites that only change the
// assignment).
// ============================================================

export interface DispatchConversationAssignedArgs {
  accountId: string
  conversationId: string
  /** Null when the conversation's contact_id is unknown to the caller
   *  (dispatch is skipped — the trigger needs a contact to fire
   *  against, same as every other automation trigger). */
  contactId: string | null
  agentId: string
  /**
   * The context this assignment happened INSIDE, if it was itself
   * triggered by an automation step (e.g. an `assign_conversation`
   * step). Carries the chain-depth counter forward so a
   * `conversation_assigned` automation whose own `assign_conversation`
   * step reassigns the thread can't loop with another automation
   * indefinitely. Omit for a root action (a human clicking the assign
   * dropdown, the AI take-over button, the AI's own auto-handoff) —
   * those start the chain at depth 0.
   */
  sourceContext?: AutomationContext
}

/**
 * Fire the `conversation_assigned` automation trigger. Only call this
 * AFTER the assignment write itself has succeeded. Best-effort — a
 * failure here must never surface as the assignment action failing;
 * it's logged and swallowed, matching how every other automation
 * dispatch in this codebase (webhook inbound, tag_added) treats its
 * own failures as non-fatal to the caller.
 */
export async function dispatchConversationAssignedTrigger(
  args: DispatchConversationAssignedArgs,
): Promise<void> {
  if (!args.contactId) return

  const depth = getConversationAssignChainDepth(args.sourceContext)
  if (depth >= MAX_CONVERSATION_ASSIGN_CHAIN_DEPTH) {
    console.warn('[assign] conversation_assigned chain depth limit reached', {
      conversationId: args.conversationId,
      agentId: args.agentId,
      depth,
    })
    return
  }

  await runAutomationsForTrigger({
    accountId: args.accountId,
    triggerType: 'conversation_assigned',
    contactId: args.contactId,
    context: {
      ...args.sourceContext,
      conversation_id: args.conversationId,
      agent_id: args.agentId,
      vars: {
        ...(args.sourceContext?.vars ?? {}),
        _conversation_assign_chain_depth: depth + 1,
      },
    },
  }).catch((err) => {
    console.error('[assign] conversation_assigned dispatch failed:', err)
  })
}

export interface AssignConversationArgs {
  conversationId: string
  accountId: string
  /** New assignee, or null to unassign. */
  agentId: string | null
}

export interface AssignConversationResult {
  contactId: string | null
  error: string | null
}

/**
 * Assign (or unassign) a conversation, then — only on an actual
 * assignment, not an unassign — dispatch `conversation_assigned`.
 * Account-scoped: a conversation outside `accountId` isn't found and
 * doesn't error, matching the RLS-backed "not found" convention used
 * elsewhere in the API routes.
 *
 * The convenience path for a call site whose only job is changing the
 * assignment. A site that needs to change other columns in the same
 * atomic update (flows/engine.ts's handoff node sets `status` too)
 * should keep its own UPDATE and call
 * `dispatchConversationAssignedTrigger` directly afterward instead.
 */
export async function assignConversation(
  db: SupabaseClient,
  args: AssignConversationArgs,
): Promise<AssignConversationResult> {
  const { data: updated, error } = await db
    .from('conversations')
    .update({ assigned_agent_id: args.agentId, updated_at: new Date().toISOString() })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)
    .select('contact_id')
    .maybeSingle()

  if (error) return { contactId: null, error: error.message }
  if (!updated) return { contactId: null, error: 'Conversa não encontrada' }

  if (args.agentId) {
    await dispatchConversationAssignedTrigger({
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: updated.contact_id as string | null,
      agentId: args.agentId,
    })
  }

  return { contactId: (updated.contact_id as string | null) ?? null, error: null }
}
