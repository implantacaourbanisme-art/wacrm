import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { assignConversation } from '@/lib/conversations/assign'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/conversations/[id]/assign  (agent+)
 *
 * Assign a conversation to an agent, or unassign it (`agent_id: null`).
 * Replaces the inbox's previous direct client-side
 * `supabase.from('conversations').update({ assigned_agent_id })` —
 * routing through here is what lets `conversation_assigned`
 * automations actually fire (see lib/conversations/assign.ts).
 *
 * Body: { agent_id: string | null }
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    // Reuse the send bucket, same reasoning as the AI take-over route:
    // a cheap per-user inbox action with no legitimate use for tight
    // looping.
    const limit = await checkRateLimit(`conv-assign:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { id: conversationId } = await params
    const body = await request.json().catch(() => null)
    if (!body || (body.agent_id !== null && typeof body.agent_id !== 'string')) {
      return NextResponse.json(
        { error: 'agent_id (string or null) is required' },
        { status: 400 },
      )
    }

    const result = await assignConversation(supabase, {
      conversationId,
      accountId,
      agentId: body.agent_id,
    })

    if (result.error) {
      const status = result.error === 'Conversation not found' ? 404 : 500
      if (status === 500) console.error('[conversations/assign] update failed:', result.error)
      return NextResponse.json({ error: result.error }, { status })
    }

    return NextResponse.json({ success: true, agent_id: body.agent_id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
