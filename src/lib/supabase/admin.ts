import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Shared, lazy service-role Supabase client.
//
// Bypasses RLS — every caller is trusted server-side code (webhook
// handlers, the Flows/Automations/AI engines, cron routes) that has
// already done its own tenancy scoping. Lazy-initialized so importing
// this module never crashes a build that hasn't set the env vars yet
// (e.g. `next build` in CI with placeholder values).
//
// This used to be the same ~10-line singleton, copy-pasted separately
// into src/lib/{flows,automations,ai}/admin-client.ts and inline in
// four more route files — every one of them independently reinventing
// the exact same client. This is the one place it's actually defined;
// the three sibling admin-client.ts files now just re-export it so
// every existing `@/lib/{flows,automations,ai}/admin-client` import
// keeps working unchanged.
// ============================================================

let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
