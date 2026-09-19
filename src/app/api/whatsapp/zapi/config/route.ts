import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  getInstanceStatus,
  configureReceivedWebhook,
  configureMessageStatusWebhook,
  ZApiError,
} from '@/lib/whatsapp/zapi-api'

/**
 * POST /api/whatsapp/zapi/config
 *
 * Saves (or switches an account to) a Z-API connection: verifies the
 * instance credentials actually work, points the instance's webhook at
 * this deployment, then persists everything to the same one-row-per-
 * account `whatsapp_config` table Meta uses (see migration 043).
 *
 * Unlike Meta's flow there is no OAuth handshake and no pre-approved
 * template step — a working instance is either already paired (QR
 * code scanned previously) or needs pairing, which the qrcode/status
 * routes handle separately from this save.
 */

// supabaseAdmin (imported above) is needed to detect an instance id
// already claimed by a *different* account, mirroring the
// phone_number_id check in /api/whatsapp/config (the RLS-scoped
// client can't see other accounts' rows).

/**
 * Resolve the base URL to publish our Z-API webhook under. Simpler
 * than the invitations route's version (no host allow-list): this
 * endpoint is already admin-only and authenticated, so the worst case
 * of trusting a spoofed Host header is an admin misconfiguring their
 * OWN account's webhook, not a phishing vector against other accounts.
 */
function webhookBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost) return `${forwardedProto || 'https'}://${forwardedHost}`
  const host = request.headers.get('host')?.trim()
  if (host) {
    const proto = new URL(request.url).protocol.replace(':', '')
    return `${proto}://${host}`
  }
  return ''
}

export async function POST(request: Request) {
  try {
    const { accountId, userId, supabase } = await requireRole('admin')

    const body = await request.json()
    const instanceId = typeof body.instance_id === 'string' ? body.instance_id.trim() : ''
    const instanceToken = typeof body.instance_token === 'string' ? body.instance_token.trim() : ''
    const clientToken = typeof body.client_token === 'string' ? body.client_token.trim() : ''

    if (!instanceId || !instanceToken || !clientToken) {
      return NextResponse.json(
        { error: 'instance_id, instance_token and client_token are all required' },
        { status: 400 }
      )
    }

    // Reject if another account already claimed this instance —
    // enforced at the DB too (migration 043's UNIQUE constraint), but
    // checking here gives a clear message instead of a raw constraint
    // violation.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('zapi_instance_id', instanceId)
      .neq('account_id', accountId)
      .maybeSingle()
    if (claimedError) {
      console.error('[zapi/config] ownership check failed:', claimedError)
      return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
    }
    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This Z-API instance is already linked to another account on this deployment.',
        },
        { status: 409 }
      )
    }

    // Verify the credentials actually work before saving anything.
    let status
    try {
      status = await getInstanceStatus({ instanceId, instanceToken, clientToken })
    } catch (err) {
      const message =
        err instanceof ZApiError
          ? err.message
          : 'Could not reach Z-API with these credentials.'
      return NextResponse.json({ error: message }, { status: 400 })
    }

    // Point both of the instance's webhooks at this deployment — the
    // route handles both event types at the same URL (dispatched by
    // the payload's `type` field). Each call is independently
    // best-effort: saved credentials are still useful even if one
    // fails (the user can retry by saving again), same philosophy as
    // Meta's /register failure path. The status-webhook endpoint path
    // is unconfirmed (see configureMessageStatusWebhook's own doc
    // comment) — its failure alone shouldn't read as "the connection
    // is broken," so it's reported separately from the received-
    // webhook error.
    const webhookUrl = `${webhookBaseUrl(request)}/api/whatsapp/zapi/webhook`
    let webhookError: string | null = null
    try {
      await configureReceivedWebhook({ instanceId, instanceToken, clientToken, webhookUrl })
    } catch (err) {
      webhookError =
        err instanceof ZApiError ? err.message : 'Could not configure the Z-API webhook.'
      console.error('[zapi/config] webhook registration failed:', webhookError)
    }
    let statusWebhookError: string | null = null
    try {
      await configureMessageStatusWebhook({ instanceId, instanceToken, clientToken, webhookUrl })
    } catch (err) {
      statusWebhookError =
        err instanceof ZApiError
          ? err.message
          : 'Could not configure the Z-API message-status webhook.'
      console.warn(
        '[zapi/config] status-webhook registration failed (delivery/read receipts will not update):',
        statusWebhookError,
      )
    }

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    const nowIso = new Date().toISOString()
    const baseRow = {
      provider: 'zapi',
      zapi_instance_id: instanceId,
      zapi_instance_token: encrypt(instanceToken),
      zapi_client_token: encrypt(clientToken),
      status: status.connected ? 'connected' : 'disconnected',
      connected_at: status.connected ? nowIso : null,
      zapi_connected_at: status.connected ? nowIso : null,
      // Switching provider — drop any Meta credential so a stale
      // secret doesn't linger once this account moves off Meta.
      access_token: null,
      verify_token: null,
      updated_at: nowIso,
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('account_id', accountId)
      if (updateError) {
        console.error('[zapi/config] update failed:', updateError)
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
      }
    } else {
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({ account_id: accountId, user_id: userId, ...baseRow })
      if (insertError) {
        console.error('[zapi/config] insert failed:', insertError)
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
      }
    }

    return NextResponse.json({
      success: true,
      connected: status.connected,
      webhook_error: webhookError,
      status_webhook_error: statusWebhookError,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
