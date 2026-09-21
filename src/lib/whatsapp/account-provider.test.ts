import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAccountWhatsAppProvider } from './account-provider'

function mockSupabase(result: { data: unknown; error?: unknown }) {
  const calls: Array<[string, unknown]> = []
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      calls.push([col, val])
      return builder
    },
    maybeSingle: async () => ({ data: result.data, error: result.error ?? null }),
  }
  const client = { from: () => builder } as unknown as SupabaseClient
  return { client, calls }
}

describe('getAccountWhatsAppProvider', () => {
  it('returns zapi and scopes by account_id', async () => {
    const { client, calls } = mockSupabase({ data: { provider: 'zapi' } })
    expect(await getAccountWhatsAppProvider(client, 'acct-1')).toBe('zapi')
    expect(calls).toContainEqual(['account_id', 'acct-1'])
  })
  it('returns meta', async () => {
    const { client } = mockSupabase({ data: { provider: 'meta' } })
    expect(await getAccountWhatsAppProvider(client, 'a')).toBe('meta')
  })
  it('treats unset provider on an existing row as meta', async () => {
    const { client } = mockSupabase({ data: { provider: null } })
    expect(await getAccountWhatsAppProvider(client, 'a')).toBe('meta')
  })
  it('returns null when there is no config row', async () => {
    const { client } = mockSupabase({ data: null })
    expect(await getAccountWhatsAppProvider(client, 'a')).toBeNull()
  })
  it('returns null on query error', async () => {
    const { client } = mockSupabase({ data: null, error: { message: 'x' } })
    expect(await getAccountWhatsAppProvider(client, 'a')).toBeNull()
  })
})
