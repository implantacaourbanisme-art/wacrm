// Re-exports the shared service-role client (src/lib/supabase/admin.ts)
// under this module's historical path, so every existing
// `@/lib/ai/admin-client` import keeps working unchanged. The inbound
// webhook has no `auth.uid()`, so the AI auto-reply path reads config
// + conversation state and sends through the service role.
export { supabaseAdmin } from '@/lib/supabase/admin'
