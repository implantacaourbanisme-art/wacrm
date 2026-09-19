// Re-exports the shared service-role client (src/lib/supabase/admin.ts)
// under this module's historical path, so every existing
// `@/lib/automations/admin-client` import keeps working unchanged.
export { supabaseAdmin } from '@/lib/supabase/admin'
