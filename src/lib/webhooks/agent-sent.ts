// ============================================================
// `message.sent` — emitted when a HUMAN agent sends a message from
// the Inbox. External automations (the n8n bot) subscribe to it to
// stop answering that customer while a person is on the thread. It is
// deliberately NOT emitted for the public API, Flows or AI replies.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

/** Digits only — the same shape Z-API (and the n8n bot) use for a phone. */
export function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '')
}

export async function notifyAgentMessageSent(
  db: SupabaseClient,
  accountId: string,
  args: { conversationId: string; messageId: string; whatsappMessageId: string; text: string | null }
): Promise<void> {
  try {
    const { data } = await db
      .from('conversations')
      .select('contact_id, contacts(phone)')
      .eq('id', args.conversationId)
      .eq('account_id', accountId)
      .maybeSingle()

    const contacts = (data as { contacts?: unknown } | null)?.contacts
    const contact = (Array.isArray(contacts) ? contacts[0] : contacts) as
      | { phone?: string | null }
      | undefined
    const phone = phoneDigits(contact?.phone)
    if (!data || !phone) return

    await dispatchWebhookEvent(db, accountId, 'message.sent', {
      conversation_id: args.conversationId,
      contact_id: (data as { contact_id: string }).contact_id,
      phone,
      message_id: args.messageId,
      whatsapp_message_id: args.whatsappMessageId,
      text: args.text,
    })
  } catch (err) {
    console.error('[webhooks] message.sent notify failed:', err)
  }
}
