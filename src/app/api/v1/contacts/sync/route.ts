// ============================================================
// POST /api/v1/contacts/sync — idempotent bulk upsert of contacts
// (scope: contacts:write). Used by the n8n "Leads → WACRM" workflow.
//
// Body: { "contacts": [ { "phone": "+558296004382", "name": "Ana",
//   "email": "ana@x.com", "custom_fields": { "CPF/CNPJ": "529.982.247-25" } } ] }
// (max 100 per call). Response (200): { "data": { "created", "updated",
//   "unchanged", "failed": [ { "index", "phone", "error" } ] } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { ContactError, resolveAuditUserId } from '@/lib/api/v1/contacts';
import { parseSyncBody, applyContactSync } from '@/lib/contacts/sync';

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');

    const body = await request.json().catch(() => null);
    const parsed = parseSyncBody(body);
    if (!parsed.ok) {
      return fail('bad_request', parsed.message, 400);
    }

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
    const result = await applyContactSync(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      parsed.items,
      parsed.invalid
    );
    return ok(result, 200);
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(err.status === 400 ? 'bad_request' : 'internal', err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
