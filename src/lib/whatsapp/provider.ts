/**
 * Provider-agnostic WhatsApp send contract.
 *
 * `send-message.ts`, the Flows engine, and the Automations engine each
 * load a `whatsapp_config` row and used to call meta-api.ts directly
 * with `phoneNumberId` + `accessToken`. That hardcoded Meta as the only
 * possible transport. This module is the one place that branches on
 * `config.provider` — every caller gets back the same
 * `WhatsAppSendProvider` shape regardless of which one the account
 * connected, and never needs its own if/else.
 *
 * Templates are the one place the two providers genuinely disagree:
 * Meta requires a pre-approved template outside the 24h window and
 * sends a structured `template` message; Z-API has no template concept
 * at all (it's a WhatsApp Web session — everything is free-form). The
 * `renderedText` field on `SendTemplateArgs` is how a caller reconciles
 * this — see `sendTemplate` below.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sendTextMessage as metaSendText,
  sendMediaMessage as metaSendMedia,
  sendTemplateMessage as metaSendTemplate,
  sendInteractiveButtons as metaSendInteractiveButtons,
  sendInteractiveList as metaSendInteractiveList,
  sendReactionMessage as metaSendReaction,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import {
  zapiSendText,
  zapiSendMedia,
  zapiSendButtonList,
  zapiSendOptionList,
  zapiSendReaction,
} from '@/lib/whatsapp/zapi-api'
import type { InteractiveButton, InteractiveListSection } from '@/lib/whatsapp/interactive'
import type { MessageTemplate } from '@/types'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'

export type { MediaKind }
export type WhatsAppProviderKind = 'meta' | 'zapi'

export interface ProviderSendResult {
  messageId: string
}

export interface SendTextArgs {
  to: string
  text: string
  contextMessageId?: string
}

export interface SendMediaArgs {
  to: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export interface SendTemplateArgs {
  to: string
  templateName: string
  language: string
  /** Meta-only — drives header/button components via buildSendComponents. */
  template?: MessageTemplate
  messageParams?: SendTimeParams
  params?: string[]
  /**
   * The body with `{{n}}` placeholders already substituted (via
   * `templateContentText` in template-body.ts). Meta ignores this — it
   * builds its own components from `template`/`messageParams`/`params`.
   * Z-API requires it: since it has no template system, a "template"
   * send there is just this text sent as a plain message.
   */
  renderedText: string | null
  contextMessageId?: string
}

export interface SendInteractiveButtonsArgs {
  to: string
  body: string
  header?: string
  footer?: string
  buttons: InteractiveButton[]
  contextMessageId?: string
}

export interface SendInteractiveListArgs {
  to: string
  body: string
  buttonLabel: string
  header?: string
  footer?: string
  sections: InteractiveListSection[]
  contextMessageId?: string
}

export interface SendReactionArgs {
  to: string
  /** The target message's PROVIDER id (messages.message_id) — Meta's
   *  wamid or Z-API's messageId. */
  targetMessageId: string
  /** Single emoji, or empty string to remove an existing reaction. */
  emoji: string
}

export interface WhatsAppSendProvider {
  readonly kind: WhatsAppProviderKind
  sendText(args: SendTextArgs): Promise<ProviderSendResult>
  sendMedia(args: SendMediaArgs): Promise<ProviderSendResult>
  sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult>
  sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<ProviderSendResult>
  sendInteractiveList(args: SendInteractiveListArgs): Promise<ProviderSendResult>
  sendReaction(args: SendReactionArgs): Promise<ProviderSendResult>
}

/**
 * Meta Cloud API adapter — a thin forward to meta-api.ts. Every
 * existing call site's behavior is unchanged; this just gives it the
 * common shape so send-message.ts (and the Flows/Automations engines)
 * can stop knowing it's Meta at all.
 */
function createMetaProvider(args: {
  phoneNumberId: string
  accessToken: string
}): WhatsAppSendProvider {
  const { phoneNumberId, accessToken } = args
  return {
    kind: 'meta',
    async sendText({ to, text, contextMessageId }) {
      return metaSendText({ phoneNumberId, accessToken, to, text, contextMessageId })
    },
    async sendMedia({ to, kind, link, caption, filename, contextMessageId }) {
      return metaSendMedia({
        phoneNumberId,
        accessToken,
        to,
        kind,
        link,
        caption,
        filename,
        contextMessageId,
      })
    },
    async sendTemplate({
      to,
      templateName,
      language,
      template,
      messageParams,
      params,
      contextMessageId,
    }) {
      return metaSendTemplate({
        phoneNumberId,
        accessToken,
        to,
        templateName,
        language,
        template,
        messageParams,
        params,
        contextMessageId,
      })
    },
    async sendInteractiveButtons({ to, body, header, footer, buttons, contextMessageId }) {
      return metaSendInteractiveButtons({
        phoneNumberId,
        accessToken,
        to,
        bodyText: body,
        headerText: header,
        footerText: footer,
        buttons,
        contextMessageId,
      })
    },
    async sendInteractiveList({
      to,
      body,
      buttonLabel,
      header,
      footer,
      sections,
      contextMessageId,
    }) {
      return metaSendInteractiveList({
        phoneNumberId,
        accessToken,
        to,
        bodyText: body,
        buttonLabel,
        headerText: header,
        footerText: footer,
        sections,
        contextMessageId,
      })
    },
    async sendReaction({ to, targetMessageId, emoji }) {
      return metaSendReaction({ phoneNumberId, accessToken, to, targetMessageId, emoji })
    },
  }
}

/**
 * Z-API adapter. `contextMessageId` (swipe-reply quoting) is accepted
 * by every method but currently ignored — Z-API's reply-quote field
 * name isn't confirmed against these credentials the way send-text is,
 * so sends go out unquoted rather than guessing a field that silently
 * no-ops or errors.
 */
function createZApiProvider(args: {
  instanceId: string
  instanceToken: string
  clientToken: string
}): WhatsAppSendProvider {
  const creds = args
  return {
    kind: 'zapi',
    async sendText({ to, text }) {
      return zapiSendText({ ...creds, phone: to, message: text })
    },
    async sendMedia({ to, kind, link, caption, filename }) {
      return zapiSendMedia({ ...creds, phone: to, kind, link, caption, filename })
    },
    async sendTemplate({ to, renderedText }) {
      // No template system on Z-API — the caller already rendered the
      // body (template-body.ts's templateContentText); this is just a
      // text send. A missing renderedText means the caller has no local
      // copy of the template to render from, which we can't recover
      // from here — surface it rather than sending a blank message.
      if (!renderedText) {
        throw new Error(
          'Z-API has no template system, and no rendered template body was provided — cannot send.'
        )
      }
      return zapiSendText({ ...creds, phone: to, message: renderedText })
    },
    async sendInteractiveButtons({ to, body, buttons }) {
      return zapiSendButtonList({
        ...creds,
        phone: to,
        message: body,
        buttons: buttons.map((b) => ({ id: b.id, label: b.title })),
      })
    },
    async sendInteractiveList({ to, body, buttonLabel, sections }) {
      return zapiSendOptionList({
        ...creds,
        phone: to,
        message: body,
        buttonLabel,
        sections: sections.map((s) => ({
          title: s.title,
          rows: s.rows.map((r) => ({
            id: r.id,
            title: r.title,
            description: r.description,
          })),
        })),
      })
    },
    async sendReaction({ to, targetMessageId, emoji }) {
      return zapiSendReaction({ ...creds, phone: to, messageId: targetMessageId, emoji })
    },
  }
}

/** The subset of a `whatsapp_config` row every resolver needs. Accepts
 *  the full row too — extra fields are ignored. */
export interface WhatsAppConfigRow {
  provider?: string | null
  phone_number_id?: string | null
  access_token?: string | null
  zapi_instance_id?: string | null
  zapi_instance_token?: string | null
  zapi_client_token?: string | null
}

/**
 * Build the right `WhatsAppSendProvider` for a loaded `whatsapp_config`
 * row, decrypting whichever credentials the chosen provider needs.
 *
 * `provider` defaults to `'meta'` to match every row created before
 * migration 043 added the column (its own DB default is `'meta'` too —
 * this mirrors that at the application layer for rows read through a
 * stale client or a partial select).
 */
export function resolveSendProvider(config: WhatsAppConfigRow): WhatsAppSendProvider {
  if (config.provider === 'zapi') {
    if (!config.zapi_instance_id || !config.zapi_instance_token || !config.zapi_client_token) {
      throw new Error('Z-API connection is missing required credentials.')
    }
    return createZApiProvider({
      instanceId: config.zapi_instance_id,
      instanceToken: decrypt(config.zapi_instance_token),
      clientToken: decrypt(config.zapi_client_token),
    })
  }
  if (!config.phone_number_id || !config.access_token) {
    throw new Error('Meta connection is missing required credentials.')
  }
  return createMetaProvider({
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
  })
}

/**
 * Load `whatsapp_config` for an account and resolve its send provider
 * in one step. The Flows and Automations engines each used to do this
 * inline (querying only `phone_number_id, access_token`); this is the
 * shared version that works for either provider.
 */
export async function loadWhatsAppSendProvider(
  db: SupabaseClient,
  accountId: string
): Promise<WhatsAppSendProvider> {
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single()
  if (error || !config) {
    throw new Error('WhatsApp not configured for this account')
  }
  return resolveSendProvider(config)
}
