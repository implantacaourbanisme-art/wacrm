// ============================================================
// POST /api/v1/handoffs — hand a conversation off to a human agent
// (scope: conversations:write). Used by the n8n bot's Transbordo.
//
// Body: { "phone": "+558296004382", "name": "Ana", "summary": "…",
//         "assign_to_email": "agent@example.com" }
// Response (201): { "data": { "conversation_id", "contact_id",
//   "contact_created", "assigned_to": {user_id,email}|null, "note_id" } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { parseHandoffBody, performHandoff } from '@/lib/conversations/handoff';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:write');

    const body = await request.json().catch(() => null);
    const parsed = parseHandoffBody(body);
    if (!parsed.ok) {
      return fail('bad_request', parsed.message, 400);
    }

    const result = await performHandoff(ctx.supabase, ctx.accountId, parsed.value);

    return ok(
      {
        conversation_id: result.conversationId,
        contact_id: result.contactId,
        contact_created: result.contactCreated,
        assigned_to: result.assignedTo
          ? { user_id: result.assignedTo.userId, email: result.assignedTo.email }
          : null,
        note_id: result.noteId,
      },
      201
    );
  } catch (err) {
    if (err instanceof SendMessageError) {
      return fail(err.code, err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
