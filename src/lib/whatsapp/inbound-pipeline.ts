// ============================================================
// Generic inbound-message pipeline — shared by every WhatsApp
// provider's webhook route (Meta's app/api/whatsapp/webhook,
// Z-API's app/api/whatsapp/zapi/webhook).
//
// Each provider route owns parsing ITS OWN wire format into the
// normalized shapes below — Meta's payload carries media as an
// indirect id+token pair that needs its own download step, Z-API's
// shape is different again, and only the provider route understands
// its full space of inbound event types. Once normalized, everything
// from "find or create the contact" through dispatching
// Flows/Automations/AI/public-webhook events is identical regardless
// of provider, so it lives here once instead of twice.
//
// Extracted verbatim (logic unchanged) from what used to be private
// functions inside the Meta webhook route — see that route for what
// stayed Meta-specific (payload parsing, media download, signature
// verification, template-lifecycle events, status webhooks) and why.
// Log lines below carry an `[inbound-pipeline]` prefix instead of the
// old `[webhook]` — the only behavioral-adjacent change in this move.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { identityDisplayName, type WaIdentity } from '@/lib/whatsapp/wa-identity'

export type NormalizedContentType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'location'
  | 'template'
  | 'interactive'

/** A single inbound message, already parsed out of whichever
 *  provider's wire format it arrived in. */
export interface NormalizedInboundMessage {
  /** The provider's own message id (Meta's wamid, Z-API's messageId).
   *  Persisted verbatim to messages.message_id — also the idempotency
   *  key (unique index on (conversation_id, message_id), migration 037). */
  providerMessageId: string
  timestampMs: number
  /** Already resolved to a value the messages.content_type CHECK
   *  constraint accepts — the provider route owns collapsing its own
   *  type space onto this (e.g. Meta's 'sticker' → 'image'). */
  contentType: NormalizedContentType
  /** Raw provider-specific type label — used only for the "[label]"
   *  fallback text (when there's no content_text) and log lines. */
  rawTypeLabel: string
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  interactiveReplyId: string | null
  /** The provider's own id of the message this one quote-replies to,
   *  if any. Resolved to our internal UUID here. */
  replyToProviderMessageId?: string | null
}

/** A reaction event — not a message. WhatsApp models these as
 *  per-(target, actor) state, not a new row in `messages`. */
export interface InboundReactionEvent {
  targetProviderMessageId: string
  /** Empty string means "reaction removed" per WhatsApp's convention. */
  emoji: string
}

export interface IngestInboundArgs {
  /** Tenancy — drives every contact / conversation lookup and the
   *  engines' active-row dispatch. */
  accountId: string
  /** Audit / sender-of-record for inserts that need a NOT NULL user_id
   *  FK (contacts, conversations). Always the admin who saved the
   *  provider's config row. */
  configOwnerUserId: string
  identity: WaIdentity
  /** Exactly one of `reaction` or `message` must be set. */
  reaction?: InboundReactionEvent
  message?: NormalizedInboundMessage
}

// ============================================================
// Contact resolution
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch below. */
  wasCreated: boolean
}

/**
 * Look a contact up by BSUID. Exact match on the column backing
 * migration 040's unique index — no fuzzy matching, because a BSUID is
 * an opaque identifier with exactly one correct spelling. Meta-only
 * concept (Z-API identities only ever carry a phone), but harmless to
 * call unconditionally — it just never matches for a zapi identity.
 */
async function findContactByWaUserId(
  accountId: string,
  waUserId: string
): Promise<ContactRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('wa_user_id', waUserId)
    .maybeSingle()

  if (error) {
    console.error('[inbound-pipeline] BSUID contact lookup failed:', error.message)
    return null
  }
  return data ?? null
}

/**
 * Fields worth writing back onto a contact we just matched, given what
 * this delivery told us. Returns null when nothing changed, so the
 * common case costs no UPDATE.
 */
function contactIdentityPatch(
  existing: ContactRow,
  identity: WaIdentity
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}

  const name = identity.name || identity.waUsername
  if (name && name !== existing.name) patch.name = name

  if (identity.waUserId && identity.waUserId !== existing.wa_user_id) {
    patch.wa_user_id = identity.waUserId
  }
  if (
    identity.waParentUserId &&
    identity.waParentUserId !== existing.wa_parent_user_id
  ) {
    patch.wa_parent_user_id = identity.waParentUserId
  }
  if (identity.waUsername && identity.waUsername !== existing.wa_username) {
    patch.wa_username = identity.waUsername
  }
  if (identity.phone && !normalizePhone(existing.phone ?? '')) {
    patch.phone = identity.phone
  }

  return Object.keys(patch).length > 0 ? patch : null
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  identity: WaIdentity
): Promise<ContactOutcome | null> {
  let existingContact: ContactRow | null = identity.waUserId
    ? await findContactByWaUserId(accountId, identity.waUserId)
    : null

  if (!existingContact && identity.phone) {
    existingContact = await findExistingContact(
      supabaseAdmin(),
      accountId,
      identity.phone,
    )
  }

  if (existingContact) {
    const patch = contactIdentityPatch(existingContact, identity)
    if (patch) {
      const { data: updated, error: updateError } = await supabaseAdmin()
        .from('contacts')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
        .select()
        .maybeSingle()

      if (updateError) {
        console.error(
          '[inbound-pipeline] contact identity backfill failed:',
          updateError.message
        )
      } else if (updated) {
        existingContact = updated
      }
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone: identity.phone,
      name: identityDisplayName(identity),
      wa_user_id: identity.waUserId,
      wa_parent_user_id: identity.waParentUserId,
      wa_username: identity.waUsername,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = identity.waUserId
        ? await findContactByWaUserId(accountId, identity.waUserId)
        : null
      if (raced) return { contact: raced, wasCreated: false }
      if (identity.phone) {
        const racedByPhone = await findExistingContact(
          supabaseAdmin(),
          accountId,
          identity.phone
        )
        if (racedByPhone) return { contact: racedByPhone, wasCreated: false }
      }
    }
    console.error('[inbound-pipeline] Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[inbound-pipeline] Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('[inbound-pipeline] Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

/**
 * Resolve a provider-side message id into the matching internal UUID,
 * scoped to one conversation. Returns null when we never received the
 * parent (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalMessageId(
  providerMessageId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', providerMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[inbound-pipeline] lookupInternalMessageId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. Upserts / deletes on `message_reactions`
 * rather than inserting into `messages`.
 */
async function handleReaction(
  reaction: InboundReactionEvent,
  conversationId: string,
  contactId: string
): Promise<void> {
  const targetInternalId = await lookupInternalMessageId(
    reaction.targetProviderMessageId,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[inbound-pipeline] reaction target message not found; skipping',
      reaction.targetProviderMessageId
    )
    return
  }

  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[inbound-pipeline] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[inbound-pipeline] reaction upsert failed:', upsertError.message)
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast. Best-effort — failures are
 * swallowed with a log so they never break the main inbound flow.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('[inbound-pipeline] Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('[inbound-pipeline] flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * The generic tail of inbound processing: find-or-create the contact
 * and conversation, persist the message (or reaction), and dispatch to
 * Flows / Automations / AI auto-reply / public webhooks. Called by
 * every provider's webhook route once it has normalized its own wire
 * format into `IngestInboundArgs`.
 *
 * Callers are expected to have already rejected an identity with
 * neither a phone nor a BSUID before calling this — see each
 * provider's own route for that guard, which needs the raw payload to
 * log a useful error.
 */
export async function ingestInboundMessage(args: IngestInboundArgs): Promise<void> {
  const { accountId, configOwnerUserId, identity, reaction, message } = args

  const contactOutcome = await findOrCreateContact(accountId, configOwnerUserId, identity)
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(accountId, configOwnerUserId, contactRecord.id)
  if (!convResult) return
  const conversation = convResult.conversation

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened
  // by a reaction still fires the event, and a subscriber always sees
  // the thread open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions short-circuit here — they aren't messages. We never
  // insert into `messages`, never bump unread_count, never update
  // last_message_text.
  if (reaction) {
    if (!reaction.targetProviderMessageId) return
    await handleReaction(reaction, conversation.id, contactRecord.id)
    return
  }
  if (!message) return // defensive — callers always pass one or the other

  let replyToInternalId: string | null = null
  if (message.replyToProviderMessageId) {
    replyToInternalId = await lookupInternalMessageId(
      message.replyToProviderMessageId,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[inbound-pipeline] reply context parent not found:',
        message.replyToProviderMessageId
      )
    }
  }

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // Idempotent insert — a provider retrying a delivery replays the
  // exact same message id. The unique index on
  // (conversation_id, message_id) (migration 037) makes a replay
  // conflict; ignoreDuplicates turns that into ON CONFLICT DO NOTHING,
  // and the .select() then returns the row ONLY on a genuine first
  // insert — an empty result means this delivery was a replay.
  const { data: insertedRows, error: msgError } = await supabaseAdmin()
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: message.contentType,
        content_text: message.contentText,
        media_url: message.mediaUrl,
        media_type: message.mediaType,
        message_id: message.providerMessageId,
        status: 'delivered',
        created_at: new Date(message.timestampMs).toISOString(),
        reply_to_message_id: replyToInternalId,
        interactive_reply_id: message.interactiveReplyId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id')

  if (msgError) {
    console.error('[inbound-pipeline] Error inserting message:', msgError)
    return
  }

  if (!insertedRows || insertedRows.length === 0) {
    console.info(
      '[inbound-pipeline] duplicate inbound message ignored (idempotent replay):',
      message.providerMessageId
    )
    return
  }

  // Unread bump + last-message summary done DB-side (migration 037's
  // bump_conversation_on_inbound) rather than a read-modify-write, so
  // two concurrent inbound messages for the same conversation can't
  // lose an increment.
  const { error: convError } = await supabaseAdmin().rpc(
    'bump_conversation_on_inbound',
    {
      p_conversation_id: conversation.id,
      p_last_message_text: message.contentText || `[${message.rawTypeLabel}]`,
    }
  )
  if (convError) {
    console.error('[inbound-pipeline] Error updating conversation:', convError)
  }

  // A customer writing again re-opens the thread (issue #409).
  await reopenClosedConversation(supabaseAdmin(), conversation)

  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // Flow runner dispatch. If it consumes the message, suppress the
  // content-level automation triggers (customer is navigating the bot
  // menu, not sending a fresh trigger word) — relationship-level
  // triggers still fire regardless.
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: message.interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: message.interactiveReplyId,
          reply_title: message.contentText ?? '',
          meta_message_id: message.providerMessageId,
        }
      : {
          kind: 'text',
          text: message.contentText ?? '',
          meta_message_id: message.providerMessageId,
        },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = message.contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (message.interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: message.interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply — only for plain-text inbound the flow runner did
  // NOT consume, and only when the account has enabled it.
  if (!flowConsumed && !message.interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
      inboundMessageId: message.providerMessageId,
    })
  }

  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.providerMessageId,
    content_type: message.contentType,
    text: message.contentText,
  })
}
