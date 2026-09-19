// Same pattern as src/lib/contacts/tag-chain.ts, for a different chain:
// automation A's `assign_conversation` step can fire `conversation_assigned`,
// which automation B (listening to that trigger) can answer with its own
// `assign_conversation` step, which fires `conversation_assigned` again —
// unbounded without a depth cap. This didn't exist as a risk before
// `conversation_assigned` actually dispatched (see assign.ts); now that it
// does, every dispatch site needs the same guard tag_added already has.

export const MAX_CONVERSATION_ASSIGN_CHAIN_DEPTH = 3;

export function getConversationAssignChainDepth(context?: {
  vars?: Record<string, unknown>;
}): number {
  const raw = context?.vars?._conversation_assign_chain_depth;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : 0;
}
