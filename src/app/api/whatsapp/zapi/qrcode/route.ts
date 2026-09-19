import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getInstanceStatus, getQrCodeImage, ZApiError } from '@/lib/whatsapp/zapi-api'

/**
 * GET /api/whatsapp/zapi/qrcode
 *
 * Returns the current pairing QR code for the account's saved Z-API
 * instance, for the settings panel to render while the user scans it.
 * The panel is expected to poll this (and /status) on a timer while
 * open — the code expires after a short, undocumented window.
 */
export async function GET() {
  try {
    const { accountId, supabase } = await requireRole('admin')

    const { data: config, error } = await supabase
      .from('whatsapp_config')
      .select('provider, zapi_instance_id, zapi_instance_token, zapi_client_token')
      .eq('account_id', accountId)
      .eq('provider', 'zapi')
      .maybeSingle()

    if (error) {
      console.error('[zapi/qrcode] config lookup failed:', error)
      return NextResponse.json({ error: 'Failed to load configuration' }, { status: 500 })
    }
    if (!config || !config.zapi_instance_id || !config.zapi_instance_token || !config.zapi_client_token) {
      return NextResponse.json(
        { error: 'No Z-API connection saved for this account yet.' },
        { status: 404 }
      )
    }

    const creds = {
      instanceId: config.zapi_instance_id,
      instanceToken: decrypt(config.zapi_instance_token),
      clientToken: decrypt(config.zapi_client_token),
    }

    // Check status first — an already-connected instance has no QR to
    // show, and asking for one anyway is wasted round trips.
    const status = await getInstanceStatus(creds)
    if (status.connected) {
      return NextResponse.json({ connected: true, qr_code: null })
    }

    const qr = await getQrCodeImage(creds)
    return NextResponse.json({ connected: false, qr_code: qr?.value ?? null })
  } catch (err) {
    if (err instanceof ZApiError) {
      return NextResponse.json({ error: err.message }, { status: 502 })
    }
    return toErrorResponse(err)
  }
}
