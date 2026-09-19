import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  ingestInboundMessage,
  type NormalizedContentType,
  type NormalizedInboundMessage,
} from '@/lib/whatsapp/inbound-pipeline'
import { hasUsableIdentity, type WaIdentity } from '@/lib/whatsapp/wa-identity'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import {
  ingestStatusUpdate,
  type NormalizedDeliveryStatus,
} from '@/lib/whatsapp/status-pipeline'

// Same rationale as the Meta webhook route: ack fast, keep working via
// `after()` so a serverless freeze right after the response can't drop
// a partially-processed delivery.
export const maxDuration = 60

// ============================================================
// Z-API webhook shapes. Both the "message received" and "message
// status changed" events land on the SAME configured callback URL —
// Z-API's own examples show a `type` field ("ReceivedCallback" /
// "MessageStatusCallback") distinguishing them, and both are
// registered from the same config route (zapi/config/route.ts) —
// so this one handler dispatches on `type` rather than needing a
// second route.
//
// Confirmed against
//   https://developer.z-api.io/webhooks/on-message-received-examples
//   https://developer.z-api.io/webhooks/on-whatsapp-message-status-changes
// — field names below are taken directly from those pages' JSON
// examples. Re-check them (or log a raw payload) before relying on a
// field not exercised by the parsing below — Z-API is a third-party
// API with no official SDK, and this route hasn't been validated
// against a live account's webhook feed end-to-end.
// ============================================================

interface ZApiTextContent {
  message: string
}
interface ZApiImageContent {
  mimeType: string
  imageUrl: string
  caption?: string
}
interface ZApiDocumentContent {
  documentUrl: string
  mimeType: string
  fileName?: string
}
interface ZApiAudioContent {
  audioUrl: string
  mimeType: string
}
interface ZApiVideoContent {
  videoUrl: string
  mimeType: string
  caption?: string
}
interface ZApiButtonsResponse {
  buttonId: string
  message: string
}
interface ZApiListResponse {
  message: string
  title?: string
  selectedRowId: string
}
interface ZApiReaction {
  /** Empty/absent means "reaction removed". */
  value?: string
  referencedMessage?: { messageId: string }
}

interface ZApiWebhookBody {
  instanceId: string
  /** Discriminator between the two event shapes this route handles —
   *  "ReceivedCallback" for a message, "MessageStatusCallback" for a
   *  delivery/read status update. Anything else is treated as a
   *  message (matches this route's pre-status-support behavior). */
  type?: string
  messageId: string
  phone: string
  /** True when this event is an echo of a message WE sent (through
   *  Z-API or the paired phone itself) — never a customer inbound.
   *  Must be skipped, or our own sends would double up as a fake
   *  "customer" message. */
  fromMe?: boolean
  /** WhatsApp groups don't map onto this CRM's 1:1 contact model
   *  (Meta's Cloud API doesn't deliver group messages either, so this
   *  keeps the two providers at parity). */
  isGroup?: boolean
  momment?: number
  senderName?: string
  /** Present on a swipe-reply to a non-reaction message. */
  referenceMessageId?: string
  text?: ZApiTextContent
  image?: ZApiImageContent
  document?: ZApiDocumentContent
  audio?: ZApiAudioContent
  video?: ZApiVideoContent
  buttonsResponseMessage?: ZApiButtonsResponse
  listResponseMessage?: ZApiListResponse
  reaction?: ZApiReaction
  // ---- MessageStatusCallback fields (type === 'MessageStatusCallback') ----
  /** SENT | RECEIVED | READ | READ_BY_ME | PLAYED. */
  status?: string
  /** One status update can cover several message ids at once. */
  ids?: string[]
}

/**
 * Map Z-API's status vocabulary onto the shared pipeline's ladder.
 * RECEIVED means the recipient's device got it — Meta calls that
 * "delivered", so that's the mapping here despite the different word.
 * PLAYED (voice notes) counts as read — the recipient engaged with it.
 * READ_BY_ME is the paired phone's OWNER reading their own chat, not a
 * signal about the customer, so it maps to null (nothing to mirror).
 */
export function mapZApiStatus(raw: string | undefined): NormalizedDeliveryStatus | null {
  switch (raw) {
    case 'SENT':
      return 'sent'
    case 'RECEIVED':
      return 'delivered'
    case 'READ':
    case 'PLAYED':
      return 'read'
    default:
      return null
  }
}

function normalizeContent(body: ZApiWebhookBody): {
  contentType: NormalizedContentType
  rawTypeLabel: string
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  interactiveReplyId: string | null
} {
  if (body.text) {
    return {
      contentType: 'text',
      rawTypeLabel: 'text',
      contentText: body.text.message || null,
      mediaUrl: null,
      mediaType: null,
      interactiveReplyId: null,
    }
  }
  if (body.image) {
    return {
      contentType: 'image',
      rawTypeLabel: 'image',
      contentText: body.image.caption || null,
      mediaUrl: body.image.imageUrl || null,
      mediaType: body.image.mimeType || null,
      interactiveReplyId: null,
    }
  }
  if (body.video) {
    return {
      contentType: 'video',
      rawTypeLabel: 'video',
      contentText: body.video.caption || null,
      mediaUrl: body.video.videoUrl || null,
      mediaType: body.video.mimeType || null,
      interactiveReplyId: null,
    }
  }
  if (body.document) {
    return {
      contentType: 'document',
      rawTypeLabel: 'document',
      contentText: body.document.fileName || null,
      mediaUrl: body.document.documentUrl || null,
      mediaType: body.document.mimeType || null,
      interactiveReplyId: null,
    }
  }
  if (body.audio) {
    return {
      contentType: 'audio',
      rawTypeLabel: 'audio',
      contentText: null,
      mediaUrl: body.audio.audioUrl || null,
      mediaType: body.audio.mimeType || null,
      interactiveReplyId: null,
    }
  }
  if (body.buttonsResponseMessage) {
    return {
      contentType: 'interactive',
      rawTypeLabel: 'buttonsResponseMessage',
      contentText: body.buttonsResponseMessage.message || null,
      mediaUrl: null,
      mediaType: null,
      interactiveReplyId: body.buttonsResponseMessage.buttonId || null,
    }
  }
  if (body.listResponseMessage) {
    return {
      contentType: 'interactive',
      rawTypeLabel: 'listResponseMessage',
      contentText:
        body.listResponseMessage.title || body.listResponseMessage.message || null,
      mediaUrl: null,
      mediaType: null,
      interactiveReplyId: body.listResponseMessage.selectedRowId || null,
    }
  }
  return {
    contentType: 'text',
    rawTypeLabel: 'unknown',
    contentText: '[Unsupported message type]',
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }
}

export async function POST(request: Request) {
  let body: ZApiWebhookBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.instanceId) {
    return NextResponse.json({ error: 'Missing instanceId' }, { status: 400 })
  }

  // Resolve tenancy by instance id (UNIQUE per migration 043 — mirrors
  // how the Meta route resolves by phone_number_id).
  const { data: config, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('provider', 'zapi')
    .eq('zapi_instance_id', body.instanceId)
    .maybeSingle()

  if (configError) {
    console.error('[zapi-webhook] Error fetching whatsapp_config:', configError)
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
  }
  if (!config) {
    console.error('[zapi-webhook] No config found for instanceId:', body.instanceId)
    // 200, not 404/401 — an unrecognized instance id is not proof of a
    // forged request (e.g. a stale webhook still configured on an
    // instance that was disconnected here), and Z-API has no signed-
    // payload scheme to distinguish the two. Logging it is what matters.
    return NextResponse.json({ status: 'unknown_instance' })
  }

  // Client-Token doubles as the webhook's authentication: the same
  // account-level security token used to authenticate OUR calls TO
  // Z-API. Unlike Meta's HMAC-signed payload, this is a shared static
  // secret — reject outright rather than accept an unauthenticated
  // request from anyone who finds/guesses this URL and an instance id.
  // Confirm in your Z-API dashboard that webhook calls are configured
  // to include this header before relying on it in production.
  const clientToken = request.headers.get('client-token')
  let expectedClientToken: string
  try {
    expectedClientToken = decrypt(config.zapi_client_token)
  } catch (err) {
    console.error('[zapi-webhook] failed to decrypt stored client token:', err)
    return NextResponse.json({ error: 'Configuration error' }, { status: 500 })
  }
  if (!clientToken || clientToken !== expectedClientToken) {
    console.warn('[zapi-webhook] rejected request with missing/invalid Client-Token')
    return NextResponse.json({ error: 'Invalid Client-Token' }, { status: 401 })
  }

  after(async () => {
    try {
      await processZApiWebhook(body, config)
    } catch (error) {
      console.error('[zapi-webhook] Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' })
}

async function processZApiWebhook(
  body: ZApiWebhookBody,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any
): Promise<void> {
  if (body.type === 'MessageStatusCallback') {
    const normalizedStatus = mapZApiStatus(body.status)
    if (!normalizedStatus) return // READ_BY_ME or an unrecognized value — nothing to mirror
    const timestampMs = body.momment ?? Date.now()
    for (const id of body.ids ?? []) {
      await ingestStatusUpdate({ providerMessageId: id, status: normalizedStatus, timestampMs })
    }
    return
  }

  // Never ingest our own outbound sends echoed back, and never ingest
  // group traffic — this CRM's contact model is 1:1, same as Meta's
  // Cloud API (which never delivers group messages at all).
  if (body.fromMe) return
  if (body.isGroup) {
    console.info('[zapi-webhook] skipping group message:', body.messageId)
    return
  }
  // Z-API identities are always phone-based — there's no BSUID/username
  // concept here (that's specific to Meta's username rollout).
  const identity: WaIdentity = {
    phone: normalizePhone(body.phone ?? ''),
    waUserId: null,
    waParentUserId: null,
    waUsername: null,
    name: body.senderName?.trim() ?? '',
  }
  if (!hasUsableIdentity(identity)) {
    console.error('[zapi-webhook] inbound event carries no usable phone; skipping:', body.messageId)
    return
  }

  if (body.reaction) {
    await ingestInboundMessage({
      accountId: config.account_id,
      configOwnerUserId: config.user_id,
      identity,
      reaction: {
        targetProviderMessageId: body.reaction.referencedMessage?.messageId ?? '',
        emoji: body.reaction.value ?? '',
      },
    })
    return
  }

  const normalized = normalizeContent(body)
  const message: NormalizedInboundMessage = {
    providerMessageId: body.messageId,
    timestampMs: body.momment ?? Date.now(),
    contentType: normalized.contentType,
    rawTypeLabel: normalized.rawTypeLabel,
    contentText: normalized.contentText,
    mediaUrl: normalized.mediaUrl,
    mediaType: normalized.mediaType,
    interactiveReplyId: normalized.interactiveReplyId,
    replyToProviderMessageId: body.referenceMessageId ?? null,
  }

  await ingestInboundMessage({
    accountId: config.account_id,
    configOwnerUserId: config.user_id,
    identity,
    message,
  })
}
