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
  classifyZApiMessageEvent,
  isMirrorAuthMissing,
  isMirrorRequest,
} from '@/lib/whatsapp/mirror-mode'
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

export interface ZApiWebhookBody {
  instanceId: string
  /** Discriminator between the two event shapes this route handles —
   *  "ReceivedCallback" for a message, "MessageStatusCallback" for a
   *  delivery/read status update. Anything else is treated as a
   *  message (matches this route's pre-status-support behavior). */
  type?: string
  messageId: string
  phone?: string
  senderPhone?: string
  sender?: string
  chatId?: string
  chatName?: string
  connectedPhone?: string
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
  text?: ZApiTextContent | string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message?: any
  image?: ZApiImageContent
  document?: ZApiDocumentContent
  audio?: ZApiAudioContent
  video?: ZApiVideoContent
  sticker?: { stickerUrl?: string; mimeType?: string }
  location?: { latitude?: number; longitude?: number; name?: string; address?: string; url?: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contact?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contacts?: any[]
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

export function normalizeContent(body: ZApiWebhookBody): {
  contentType: NormalizedContentType
  rawTypeLabel: string
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  interactiveReplyId: string | null
} {
  if (body.text) {
    const textMsg = typeof body.text === 'string' ? body.text : body.text.message
    if (textMsg) {
      return {
        contentType: 'text',
        rawTypeLabel: 'text',
        contentText: textMsg,
        mediaUrl: null,
        mediaType: null,
        interactiveReplyId: null,
      }
    }
  }

  // Handle direct string or nested message object
  if (body.message) {
    const msgText =
      typeof body.message === 'string'
        ? body.message
        : body.message.conversation || body.message.text || null
    if (msgText) {
      return {
        contentType: 'text',
        rawTypeLabel: 'text',
        contentText: msgText,
        mediaUrl: null,
        mediaType: null,
        interactiveReplyId: null,
      }
    }
  }

  if (body.image) {
    return {
      contentType: 'image',
      rawTypeLabel: 'image',
      contentText: body.image.caption || null,
      mediaUrl: body.image.imageUrl || null,
      mediaType: body.image.mimeType || 'image/jpeg',
      interactiveReplyId: null,
    }
  }
  if (body.video) {
    return {
      contentType: 'video',
      rawTypeLabel: 'video',
      contentText: body.video.caption || null,
      mediaUrl: body.video.videoUrl || null,
      mediaType: body.video.mimeType || 'video/mp4',
      interactiveReplyId: null,
    }
  }
  if (body.document) {
    return {
      contentType: 'document',
      rawTypeLabel: 'document',
      contentText: body.document.fileName || null,
      mediaUrl: body.document.documentUrl || null,
      mediaType: body.document.mimeType || 'application/pdf',
      interactiveReplyId: null,
    }
  }
  if (body.audio) {
    return {
      contentType: 'audio',
      rawTypeLabel: 'audio',
      contentText: null,
      mediaUrl: body.audio.audioUrl || null,
      mediaType: body.audio.mimeType || 'audio/ogg',
      interactiveReplyId: null,
    }
  }
  if (body.sticker) {
    return {
      contentType: 'image',
      rawTypeLabel: 'sticker',
      contentText: null,
      mediaUrl: body.sticker.stickerUrl || null,
      mediaType: body.sticker.mimeType || 'image/webp',
      interactiveReplyId: null,
    }
  }
  if (body.location) {
    const loc = body.location
    const locText = [
      loc.name,
      loc.address,
      loc.url ||
        (loc.latitude && loc.longitude
          ? `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`
          : null),
    ]
      .filter(Boolean)
      .join(' - ')
    return {
      contentType: 'location',
      rawTypeLabel: 'location',
      contentText: locText || 'Localização recebida',
      mediaUrl: null,
      mediaType: null,
      interactiveReplyId: null,
    }
  }
  if (body.contact || (body.contacts && body.contacts.length > 0)) {
    return {
      contentType: 'text',
      rawTypeLabel: 'contact',
      contentText: '👤 Contato compartilhado',
      mediaUrl: null,
      mediaType: null,
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

  const mirror = isMirrorRequest(request.url)

  // Tenancy is anchored on body.instanceId matching zapi_instance_id in DB.
  // If a client-token is provided (via custom header or ?token= query param),
  // validate it against the stored decrypted token.
  // Note: Z-API does NOT send custom headers on outgoing webhook callbacks,
  // so a missing header is expected and allowed.
  const clientToken =
    request.headers.get('client-token') ||
    new URL(request.url).searchParams.get('token')

  // Mirror traffic comes from n8n (which can send the header), so unlike
  // Z-API's own callbacks it must always be authenticated.
  if (isMirrorAuthMissing(mirror, clientToken, config.zapi_client_token)) {
    console.warn('[zapi-webhook] rejected mirror request without client-token')
    return NextResponse.json({ error: 'client-token required in mirror mode' }, { status: 401 })
  }

  if (clientToken && config.zapi_client_token) {
    try {
      const expectedClientToken = decrypt(config.zapi_client_token)
      if (clientToken !== expectedClientToken) {
        console.warn('[zapi-webhook] rejected request with invalid Client-Token')
        return NextResponse.json({ error: 'Invalid Client-Token' }, { status: 401 })
      }
    } catch (err) {
      console.error('[zapi-webhook] failed to decrypt stored client token:', err)
      return NextResponse.json({ error: 'Configuration error' }, { status: 500 })
    }
  }

  console.info(`[zapi-webhook] accepted webhook for instanceId: ${body.instanceId} (type: ${body.type || 'message'})`)

  after(async () => {
    try {
      await processZApiWebhook(body, config, mirror)
    } catch (error) {
      console.error('[zapi-webhook] Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' })
}

async function processZApiWebhook(
  body: ZApiWebhookBody,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
  mirror: boolean
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

  // Without ?mirror=1: never ingest our own outbound echoes and never
  // ingest group traffic (1:1 contact model). In mirror mode fromMe
  // messages are recorded as outbound.
  const action = classifyZApiMessageEvent(body, mirror)
  if (action === 'skip_outbound_echo') {
    console.info('[zapi-webhook] skipping outbound echo (fromMe=true):', body.messageId, 'phone:', body.phone)
    return
  }
  if (action === 'skip_group') {
    console.info('[zapi-webhook] skipping group message:', body.messageId)
    return
  }
  const isOutbound = action === 'ingest_outbound'
  const mirrorArg = mirror
    ? { direction: isOutbound ? ('outbound' as const) : ('inbound' as const) }
    : undefined
  // Z-API identities are always phone-based — there's no BSUID/username
  // concept here (that's specific to Meta's username rollout).
  // On fromMe, senderPhone/sender is OUR own number — never the customer.
  const chatPhone = body.chatId ? body.chatId.replace(/@.*$/, '') : ''
  const rawPhone = isOutbound
    ? body.phone || chatPhone
    : body.phone || body.senderPhone || body.sender || chatPhone

  // On fromMe, senderName is our own profile, not the customer's.
  const contactName = isOutbound
    ? body.chatName?.trim() || ''
    : body.senderName?.trim() || body.chatName?.trim() || ''

  const identity: WaIdentity = {
    phone: normalizePhone(rawPhone ?? ''),
    waUserId: null,
    waParentUserId: null,
    waUsername: null,
    name: contactName,
  }
  if (!hasUsableIdentity(identity)) {
    console.error(
      '[zapi-webhook] inbound event carries no usable phone; skipping:',
      body.messageId,
      'raw body:',
      JSON.stringify(body)
    )
    return
  }

  if (isOutbound && body.reaction) {
    console.info('[zapi-webhook] skipping outbound reaction:', body.messageId)
    return
  }

  if (body.reaction) {
    console.info(`[zapi-webhook] ingesting reaction from ${identity.phone} on ${body.reaction.referencedMessage?.messageId}`)
    await ingestInboundMessage({
      accountId: config.account_id,
      configOwnerUserId: config.user_id,
      identity,
      reaction: {
        targetProviderMessageId: body.reaction.referencedMessage?.messageId ?? '',
        emoji: body.reaction.value ?? '',
      },
      mirror: mirrorArg,
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

  console.info(
    `[zapi-webhook] ingesting inbound message ${body.messageId} (${normalized.contentType}) from ${identity.phone} for account ${config.account_id}`
  )

  await ingestInboundMessage({
    accountId: config.account_id,
    configOwnerUserId: config.user_id,
    identity,
    message,
    mirror: mirrorArg,
  })
}
