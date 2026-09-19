// ============================================================
// Generic outbound delivery-status pipeline — shared by every
// provider's status webhook (Meta's sent/delivered/read/failed
// events, Z-API's SENT/RECEIVED/READ/READ_BY_ME/PLAYED).
//
// Extracted verbatim (logic unchanged) from what used to be a private
// `handleStatusUpdate` inside the Meta webhook route — see that route
// for the Meta-specific parsing that builds a `StatusUpdateEvent`.
// Log lines below carry a `[status-pipeline]` prefix instead of being
// unprefixed — the only behavioral-adjacent change in this move.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

/** Matches the messages.status CHECK constraint's terminal values —
 *  every provider's status webhook must map onto these before calling
 *  {@link ingestStatusUpdate}. */
export type NormalizedDeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed'

export interface StatusFailureDetail {
  code?: number | null
  title: string
  details?: string | null
}

export interface StatusUpdateEvent {
  /** The provider's own message id — what we persisted as
   *  messages.message_id / broadcast_recipients.whatsapp_message_id. */
  providerMessageId: string
  status: NormalizedDeliveryStatus
  timestampMs: number
  /** Only Meta's webhook currently supplies failure detail; other
   *  providers can omit it. */
  failure?: StatusFailureDetail | null
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once a provider
// has delivered or the user has read or replied, a later "failed"
// status event is a bug in the provider's pipeline or a spoof attempt
// and must be ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
export function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

/**
 * Mirror one outbound delivery-status event onto `messages` and
 * `broadcast_recipients`, then fan it out to any subscribed public
 * webhook. Called once per (message id, status) pair — a provider
 * whose webhook batches several message ids under one status (Z-API's
 * `ids` array) calls this once per id.
 */
export async function ingestStatusUpdate(event: StatusUpdateEvent): Promise<void> {
  const { providerMessageId, status, timestampMs, failure } = event

  if (failure) {
    console.warn(
      `[status-pipeline] message ${providerMessageId} failed: [${failure.code}] ${failure.title}` +
        (failure.details ? ` — ${failure.details}` : '')
    )
  }

  // 1) Mirror onto messages — status values already match the CHECK
  //    constraint on messages.status. No `.select()`: message_id is
  //    NOT unique (migration 009 — ids repeat across numbers), so this
  //    updates 0..N rows and must not assume a single row.
  const messageUpdate: Record<string, unknown> = { status }
  if (failure) {
    messageUpdate.error_code = failure.code
    messageUpdate.error_title = failure.title
    messageUpdate.error_details = failure.details
  }
  const { error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update(messageUpdate)
    .eq('message_id', providerMessageId)

  if (msgErr) {
    console.error('[status-pipeline] Error updating message status:', msgErr)
  }

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = new Date(timestampMs).toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', providerMessageId)
    .maybeSingle()

  if (recFetchErr) {
    console.error('[status-pipeline] Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status)
  ) {
    const update: Record<string, unknown> = { status }
    if (status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (status === 'delivered') update.delivered_at = tsIso
    if (status === 'read') update.read_at = tsIso
    if (failure) {
      update.error_message =
        `[${failure.code}] ${failure.title}` +
        (failure.details ? `: ${failure.details}` : '')
    }

    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('[status-pipeline] Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', providerMessageId)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    // Supabase renders an embedded to-one join as an object or a
    // 1-array depending on schema-type inference (same shape quirk
    // broadcast-resume.ts's contactPhone() handles) — accept either.
    const convRaw = msgRow.conversations as
      | { account_id: string }
      | { account_id: string }[]
      | null
    const conv = Array.isArray(convRaw) ? convRaw[0] : convRaw
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        accountId,
        'message.status_updated',
        {
          whatsapp_message_id: providerMessageId,
          conversation_id: msgRow.conversation_id,
          status,
        }
      )
    }
  }
}
