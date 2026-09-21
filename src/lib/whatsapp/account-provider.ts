/**
 * Client-safe lookup of the account's WhatsApp transport.
 *
 * Deliberately imports nothing but types: provider.ts pulls in
 * encryption.ts (node `crypto`), which must never reach a client bundle.
 * Hooks import from here; provider.ts re-exports it for server code.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { WhatsAppProviderKind } from '@/lib/whatsapp/provider'

/**
 * Which transport the account's WhatsApp connection uses. `null` means no
 * `whatsapp_config` row (or the lookup failed) — callers treat that as
 * "not zapi". An existing row with an unset provider is a pre-migration-043
 * Meta connection.
 */
export async function getAccountWhatsAppProvider(
  supabase: SupabaseClient,
  accountId: string,
): Promise<WhatsAppProviderKind | null> {
  const { data, error } = await supabase
    .from('whatsapp_config')
    .select('provider')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data) return null
  return (data as { provider?: string | null }).provider === 'zapi' ? 'zapi' : 'meta'
}
