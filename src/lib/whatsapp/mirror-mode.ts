// ============================================================
// "Mirror mode": the n8n bot owns the Z-API instance's webhook and
// forwards a copy of every event here with ?mirror=1. In that mode
// this app only PERSISTS the conversation (so attendants can see it in
// the Inbox) — it never runs Flows / Automations / AI auto-reply nor the
// message.received / conversation.created webhooks, which would make it
// answer customers on top of the bot. Delivery/read status callbacks
// still update message statuses (and fire their status webhook) as
// before. Pure helpers, kept separate so they are trivially testable.
// ============================================================

export type ZApiMessageEventAction =
  | 'skip_group'
  | 'skip_outbound_echo'
  | 'ingest_inbound'
  | 'ingest_outbound'

/** True when the webhook request carries ?mirror=1. */
export function isMirrorRequest(url: string): boolean {
  try {
    return new URL(url).searchParams.get('mirror') === '1'
  } catch {
    return false
  }
}

/**
 * What to do with a Z-API message event. Group traffic is always
 * skipped (the contact model is 1:1). A fromMe event is our own
 * outbound echo: ignored normally, recorded as an outbound message in
 * mirror mode (that is how the bot's replies reach the Inbox).
 */
export function classifyZApiMessageEvent(
  body: { fromMe?: boolean; isGroup?: boolean },
  mirror: boolean
): ZApiMessageEventAction {
  if (body.isGroup) return 'skip_group'
  if (body.fromMe) return mirror ? 'ingest_outbound' : 'skip_outbound_echo'
  return 'ingest_inbound'
}

/** Mirror requests must be authenticated: true when mirror mode is on and
 *  either the supplied client token or the stored one is empty/absent. */
export function isMirrorAuthMissing(
  mirror: boolean,
  supplied: string | null,
  stored: string | null | undefined
): boolean {
  return mirror && (!supplied || !stored)
}

/** True when the /zapi/config body asks to save credentials without
 *  (re)pointing the Z-API instance's webhooks at this deployment. */
export function wantsSkipWebhookRegistration(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as Record<string, unknown>).skip_webhook_registration === true
  )
}
