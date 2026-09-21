// ============================================================
// Send pacing.
//
// Z-API is an UNOFFICIAL WhatsApp connection (QR code): sending many
// messages back-to-back risks getting the number banned, so broadcasts
// space out their sends when the account provider is 'zapi'. Meta (the
// official API) is unchanged — no extra delay.
// ============================================================

export const ZAPI_SEND_DELAY_MIN_MS = 3000;
export const ZAPI_SEND_DELAY_MAX_MS = 8000;

export type PacingProviderKind = 'meta' | 'zapi' | null | undefined;

/**
 * Delay to wait between two sends. Z-API: uniform random integer in
 * [MIN, MAX] inclusive; anything else: 0.
 */
export function pacingDelayMs(
  kind: PacingProviderKind,
  rand: () => number = Math.random,
): number {
  if (kind !== 'zapi') return 0;
  const span = ZAPI_SEND_DELAY_MAX_MS - ZAPI_SEND_DELAY_MIN_MS + 1;
  return ZAPI_SEND_DELAY_MIN_MS + Math.floor(rand() * span);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How the browser-driven broadcast loop batches and paces requests. */
export function broadcastSendPlan(kind: PacingProviderKind): {
  batchSize: number;
  delayMs: () => number;
} {
  if (kind === 'zapi') {
    return { batchSize: 1, delayMs: () => pacingDelayMs('zapi') };
  }
  return { batchSize: 10, delayMs: () => 1000 };
}
