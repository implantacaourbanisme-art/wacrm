/**
 * Z-API helpers — the unofficial, QR-code-paired WhatsApp provider.
 *
 * Named-params style and error shape deliberately mirror meta-api.ts so
 * the two read the same way and provider.ts can adapt both behind one
 * interface. Z-API's own conventions differ from Meta's in ways that
 * matter here:
 *
 *   - No OAuth / long-lived business token. Every call authenticates
 *     with two things: the instance credentials baked into the URL
 *     (`/instances/{id}/token/{token}/...`) and the account-level
 *     "Client-Token" security token sent as a header.
 *   - No WABA, no phone_number_id — the routable unit is the
 *     `instanceId`.
 *   - No pre-approved templates and no 24h session-window enforcement
 *     — every send is a plain message. (This also means there is no
 *     Resumable-Upload-style flow for template media headers — nothing
 *     in this file corresponds to that part of meta-api.ts.)
 *   - Pairing is a QR code the user scans with their phone, not an
 *     OAuth handoff — see getQrCodeImage / getInstanceStatus below.
 *
 * Endpoint paths below match https://developer.z-api.io/api-reference
 * as of this writing. Z-API is a third-party REST API with no official
 * Node SDK — if a call starts failing with a 404, check the current
 * path in the Z-API dashboard's API reference before assuming the
 * credentials are wrong.
 */

const ZAPI_BASE = 'https://api.z-api.io'

export interface ZApiSendResult {
  /** Z-API's id for the sent message ("zaapId" in their docs) — the
   *  closest analogue to Meta's wamid, used the same way (persisted to
   *  messages.message_id). */
  messageId: string
}

interface ZApiErrorResponse {
  error?: string
  message?: string
}

/**
 * A Z-API failure. Unlike Meta's structured `{ error: { code, ... } }`
 * envelope, Z-API's error bodies are inconsistent across endpoints
 * (sometimes `{ error }`, sometimes `{ message }`, sometimes plain
 * text) — this only carries what's reliably present: the message and
 * the HTTP status.
 */
export class ZApiError extends Error {
  readonly httpStatus: number
  constructor(message: string, httpStatus: number) {
    super(message)
    this.name = 'ZApiError'
    this.httpStatus = httpStatus
  }
}

async function readZApiError(response: Response, fallback: string): Promise<ZApiError> {
  let message = fallback
  try {
    const data = (await response.json()) as ZApiErrorResponse
    message = data.error || data.message || fallback
  } catch {
    // Body wasn't JSON — keep the fallback.
  }
  return new ZApiError(message, response.status)
}

async function throwZApiError(response: Response, fallback: string): Promise<never> {
  throw await readZApiError(response, fallback)
}

interface ZApiCredentials {
  instanceId: string
  instanceToken: string
  /** The account's "Client-Token" security token — sent on every call,
   *  not just webhooks. Z-API calls this the account security token. */
  clientToken: string
}

function instanceUrl(creds: ZApiCredentials, path: string): string {
  return `${ZAPI_BASE}/instances/${creds.instanceId}/token/${creds.instanceToken}/${path}`
}

function authHeaders(creds: ZApiCredentials): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Client-Token': creds.clientToken,
  }
}

// ============================================================
// Instance pairing / status
// ============================================================

export interface QrCodeImage {
  /** Data URL (`data:image/png;base64,...`) — Z-API returns the QR
   *  already base64-encoded; ready to drop straight into an <img src>. */
  value: string
}

/**
 * Fetch the current QR code as a base64 image for the user to scan
 * with WhatsApp on their phone. The code expires after a short window
 * (Z-API doesn't document an exact TTL) — callers should re-fetch on a
 * timer while the pairing panel is open, same as any WhatsApp-Web-style
 * QR flow.
 *
 * Returns null when the instance is already connected — there's no QR
 * to show, which the caller distinguishes from an error.
 */
export async function getQrCodeImage(
  creds: ZApiCredentials
): Promise<QrCodeImage | null> {
  const response = await fetch(instanceUrl(creds, 'qr-code/image'), {
    headers: authHeaders(creds),
  })
  if (response.status === 200) {
    const data = (await response.json()) as { value?: string }
    if (!data.value) return null
    return { value: data.value }
  }
  // Z-API answers an already-connected instance's QR request with a
  // 4xx rather than a QR payload — treat any non-200 here as "no QR to
  // show" rather than a hard failure, since getInstanceStatus is the
  // authority on connection state.
  return null
}

export interface InstanceStatus {
  connected: boolean
  /** Phone number bound to the instance once connected, if Z-API
   *  reports one (format varies; not normalized here). */
  phone?: string | null
  smartphoneConnected?: boolean
}

/** Poll whether the instance has been paired (QR scanned) yet. */
export async function getInstanceStatus(
  creds: ZApiCredentials
): Promise<InstanceStatus> {
  const response = await fetch(instanceUrl(creds, 'status'), {
    headers: authHeaders(creds),
  })
  if (!response.ok) {
    await throwZApiError(response, `Z-API error: ${response.status}`)
  }
  const data = (await response.json()) as {
    connected?: boolean
    smartphoneConnected?: boolean
    phone?: string | null
  }
  return {
    connected: Boolean(data.connected),
    phone: data.phone ?? null,
    smartphoneConnected: data.smartphoneConnected,
  }
}

export interface ConfigureWebhookArgs extends ZApiCredentials {
  /** Our /api/whatsapp/zapi/webhook URL for this deployment. */
  webhookUrl: string
}

/**
 * Point the instance's "message received" webhook at our endpoint.
 * Called once when the user saves their Z-API credentials — mirrors
 * what the Meta config route does with /register + /subscribed_apps,
 * except Z-API has a single call for this instead of two.
 */
export async function configureReceivedWebhook(
  args: ConfigureWebhookArgs
): Promise<void> {
  const { webhookUrl, ...creds } = args
  const response = await fetch(instanceUrl(creds, 'update-webhook-received'), {
    method: 'PUT',
    headers: authHeaders(creds),
    body: JSON.stringify({ value: webhookUrl }),
  })
  if (!response.ok) {
    await throwZApiError(response, `Z-API error: ${response.status}`)
  }
}

/**
 * Configure all webhooks at once using Z-API's update-every-webhooks endpoint.
 */
export async function configureEveryWebhooks(
  args: ConfigureWebhookArgs
): Promise<void> {
  const { webhookUrl, ...creds } = args
  const response = await fetch(instanceUrl(creds, 'update-every-webhooks'), {
    method: 'PUT',
    headers: authHeaders(creds),
    body: JSON.stringify({ value: webhookUrl }),
  })
  if (!response.ok) {
    await throwZApiError(response, `Z-API error: ${response.status}`)
  }
}

/**
 * Point the instance's "message status changed" webhook (delivery /
 * read receipts) at our endpoint — the sibling of
 * `configureReceivedWebhook` for the separate status-callback config
 * documented at
 * https://developer.z-api.io/webhooks/on-whatsapp-message-status-changes.
 *
 * UNCONFIRMED PATH: unlike `update-webhook-received`, the exact
 * endpoint name for this second config call wasn't pinned down from
 * the docs — `update-webhook-message-status` here follows the same
 * naming convention as the confirmed one, but hasn't been exercised
 * against a live account. Called best-effort from the config route: a
 * 404 here just means status updates won't arrive until the operator
 * also points the account's "Status da mensagem" webhook at this same
 * URL by hand in the Z-API dashboard — sending is unaffected either
 * way. Both webhook types are handled at the SAME URL
 * (`/api/whatsapp/zapi/webhook`), dispatched by the payload's `type`
 * field, since Z-API's own examples show both landing on one
 * configured callback URL.
 */
export async function configureMessageStatusWebhook(
  args: ConfigureWebhookArgs
): Promise<void> {
  const { webhookUrl, ...creds } = args
  const response = await fetch(instanceUrl(creds, 'update-webhook-message-status'), {
    method: 'PUT',
    headers: authHeaders(creds),
    body: JSON.stringify({ value: webhookUrl }),
  })
  if (!response.ok) {
    await throwZApiError(response, `Z-API error: ${response.status}`)
  }
}

// ============================================================
// Sending
// ============================================================

export interface ZApiSendTextArgs extends ZApiCredentials {
  /** Recipient in international format, digits only (no leading +) —
   *  same normalized shape phone-utils.ts already produces for Meta. */
  phone: string
  message: string
}

/** Confirmed against the endpoint the account owner pasted when this
 *  provider was set up — the one call in this file verified against a
 *  real instance rather than the docs alone. */
export async function zapiSendText(
  args: ZApiSendTextArgs
): Promise<ZApiSendResult> {
  const { phone, message, ...creds } = args
  const response = await fetch(instanceUrl(creds, 'send-text'), {
    method: 'POST',
    headers: authHeaders(creds),
    body: JSON.stringify({ phone, message }),
  })
  if (!response.ok) {
    await throwZApiError(response, `Z-API error: ${response.status}`)
  }
  const data = (await response.json()) as { messageId?: string; zaapId?: string; id?: string }
  const messageId = data.messageId || data.zaapId || data.id
  if (!messageId) {
    throw new ZApiError('Z-API send-text succeeded but returned no message id', response.status)
  }
  return { messageId }
}

export type ZApiMediaKind = 'image' | 'video' | 'document' | 'audio'

export interface ZApiSendMediaArgs extends ZApiCredentials {
  phone: string
  kind: ZApiMediaKind
  /** Public URL Z-API fetches at send time (same contract as Meta's
   *  `link` field — no base64 upload path implemented here). */
  link: string
  caption?: string
  /** Document-only — Z-API's document endpoints key the file extension
   *  into the URL path (`send-document/{extension}`) rather than
   *  reading it off the filename, unlike Meta. */
  filename?: string
}

/**
 * Send an image / video / document / audio via a public URL.
 *
 * Endpoint-per-kind, matching Z-API's REST shape (there is no single
 * generic "send-media" call). The document endpoint additionally needs
 * a file extension in the path — derived from `filename` when given,
 * falling back to a generic `pdf` slot Z-API also accepts for a link
 * whose extension it can infer server-side.
 */
export async function zapiSendMedia(
  args: ZApiSendMediaArgs
): Promise<ZApiSendResult> {
  const { phone, kind, link, caption, filename, ...creds } = args
  const path =
    kind === 'document'
      ? `send-document/${extensionFromFilename(filename) || 'pdf'}`
      : `send-${kind}`

  const body: Record<string, unknown> = { phone }
  // Z-API's field name for the media URL differs by kind (image/video
  // sends look for `image`/`video`; document/audio look for `document`
  // / `audio`) — set all the aliases the docs list for the kind so a
  // dashboard-version mismatch doesn't silently drop the attachment.
  body[kind] = link
  if (kind === 'document') body.document = link
  if (caption) body.caption = caption
  if (kind === 'document' && filename) body.fileName = filename

  const response = await fetch(instanceUrl(creds, path), {
    method: 'POST',
    headers: authHeaders(creds),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwZApiError(response, `Z-API error: ${response.status}`)
  }
  const data = (await response.json()) as { messageId?: string; zaapId?: string; id?: string }
  const messageId = data.messageId || data.zaapId || data.id
  if (!messageId) {
    throw new ZApiError('Z-API media send succeeded but returned no message id', response.status)
  }
  return { messageId }
}

function extensionFromFilename(filename?: string | null): string | null {
  if (!filename) return null
  const match = /\.([a-zA-Z0-9]+)$/.exec(filename)
  return match ? match[1].toLowerCase() : null
}

export interface ZApiButtonOption {
  id: string
  label: string
}

export interface ZApiSendButtonListArgs extends ZApiCredentials {
  phone: string
  message: string
  buttons: ZApiButtonOption[]
}

/**
 * Send a quick-reply button message.
 *
 * Caveat worth surfacing to whoever operates this account: unlike
 * Meta's Cloud API, WhatsApp itself does not officially support
 * interactive messages sent through an unofficial client — Z-API
 * renders them, but WhatsApp has tightened enforcement against
 * automated clients over time, and there are no guarantees this
 * keeps working or doesn't draw extra scrutiny to the number.
 * Treat Z-API interactive sends as best-effort, not a guaranteed
 * feature the way they are on Meta.
 */
export async function zapiSendButtonList(
  args: ZApiSendButtonListArgs
): Promise<ZApiSendResult> {
  const { phone, message, buttons, ...creds } = args
  const response = await fetch(instanceUrl(creds, 'send-button-list'), {
    method: 'POST',
    headers: authHeaders(creds),
    body: JSON.stringify({
      phone,
      message,
      buttonList: {
        buttons: buttons.map((b) => ({ id: b.id, label: b.label })),
      },
    }),
  })
  if (!response.ok) {
    await throwZApiError(response, `Z-API error: ${response.status}`)
  }
  const data = (await response.json()) as { messageId?: string; zaapId?: string; id?: string }
  const messageId = data.messageId || data.zaapId || data.id
  if (!messageId) {
    throw new ZApiError('Z-API button send succeeded but returned no message id', response.status)
  }
  return { messageId }
}

export interface ZApiOptionListRow {
  id: string
  title: string
  description?: string
}

export interface ZApiOptionListSection {
  title?: string
  rows: ZApiOptionListRow[]
}

export interface ZApiSendOptionListArgs extends ZApiCredentials {
  phone: string
  message: string
  buttonLabel: string
  sections: ZApiOptionListSection[]
}

/** Send a list message. Same best-effort caveat as zapiSendButtonList. */
export async function zapiSendOptionList(
  args: ZApiSendOptionListArgs
): Promise<ZApiSendResult> {
  const { phone, message, buttonLabel, sections, ...creds } = args
  const response = await fetch(instanceUrl(creds, 'send-option-list'), {
    method: 'POST',
    headers: authHeaders(creds),
    body: JSON.stringify({
      phone,
      message,
      optionList: {
        title: buttonLabel,
        buttonLabel,
        options: sections.flatMap((s) =>
          s.rows.map((r) => ({
            id: r.id,
            title: r.title,
            description: r.description,
          }))
        ),
      },
    }),
  })
  if (!response.ok) {
    await throwZApiError(response, `Z-API error: ${response.status}`)
  }
  const data = (await response.json()) as { messageId?: string; zaapId?: string; id?: string }
  const messageId = data.messageId || data.zaapId || data.id
  if (!messageId) {
    throw new ZApiError('Z-API option-list send succeeded but returned no message id', response.status)
  }
  return { messageId }
}

export interface ZApiSendReactionArgs extends ZApiCredentials {
  phone: string
  /** Target message's Z-API id (what we persisted as messages.message_id). */
  messageId: string
  /** Single emoji, or empty string to remove an existing reaction —
   *  confirmed as Meta's convention (see sendReactionMessage in
   *  meta-api.ts); Z-API automates the same underlying WhatsApp
   *  protocol, so the same convention is assumed here rather than
   *  independently confirmed against Z-API's own docs. */
  emoji: string
}

/** Send (or remove) a reaction to a previously-exchanged message. */
export async function zapiSendReaction(
  args: ZApiSendReactionArgs
): Promise<ZApiSendResult> {
  const { phone, messageId, emoji, ...creds } = args
  const response = await fetch(instanceUrl(creds, 'send-reaction'), {
    method: 'POST',
    headers: authHeaders(creds),
    body: JSON.stringify({ phone, messageId, reaction: emoji }),
  })
  if (!response.ok) {
    await throwZApiError(response, `Z-API error: ${response.status}`)
  }
  const data = (await response.json()) as { messageId?: string; zaapId?: string; id?: string }
  const returnedId = data.messageId || data.zaapId || data.id
  if (!returnedId) {
    throw new ZApiError('Z-API reaction send succeeded but returned no message id', response.status)
  }
  return { messageId: returnedId }
}
