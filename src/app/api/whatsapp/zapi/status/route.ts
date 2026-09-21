import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getInstanceStatus, ZApiError } from '@/lib/whatsapp/zapi-api'

/**
 * GET /api/whatsapp/zapi/status
 *
 * Polled by the settings panel while pairing is in progress. The first
 * call that reports `connected: true` also flips the saved row to
 * `status='connected'` + stamps `zapi_connected_at` — mirroring what
 * Meta's registration timestamp means for that provider (the settings
 * page's "is this actually live" signal).
 */
export async function GET() {
  try {
    const { accountId, supabase } = await requireRole('admin')

    const { data: config, error } = await supabase
      .from('whatsapp_config')
      .select('id, status, zapi_instance_id, zapi_instance_token, zapi_client_token, zapi_connected_at')
      .eq('account_id', accountId)
      .eq('provider', 'zapi')
      .maybeSingle()

    if (error) {
      console.error('[zapi/status] config lookup failed:', error)
      return NextResponse.json({ error: 'Falha ao carregar a configuração' }, { status: 500 })
    }
    if (!config || !config.zapi_instance_id || !config.zapi_instance_token || !config.zapi_client_token) {
      return NextResponse.json(
        { error: 'Nenhuma conexão Z-API salva para esta conta ainda.' },
        { status: 404 }
      )
    }

    const status = await getInstanceStatus({
      instanceId: config.zapi_instance_id,
      instanceToken: decrypt(config.zapi_instance_token),
      clientToken: decrypt(config.zapi_client_token),
    })

    if (status.connected && config.status !== 'connected') {
      const nowIso = new Date().toISOString()
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update({ status: 'connected', connected_at: nowIso, zapi_connected_at: nowIso })
        .eq('id', config.id)
      if (updateError) {
        console.error('[zapi/status] failed to persist connected state:', updateError)
      }
    }

    return NextResponse.json({
      connected: status.connected,
      phone: status.phone ?? null,
      connected_at: status.connected ? (config.zapi_connected_at ?? new Date().toISOString()) : null,
    })
  } catch (err) {
    if (err instanceof ZApiError) {
      return NextResponse.json({ error: err.message }, { status: 502 })
    }
    return toErrorResponse(err)
  }
}
