import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone, phonesMatch } from "@/lib/whatsapp/phone-utils";

/**
 * Contact de-duplication helpers, shared by the WhatsApp webhook, the
 * manual contact form, and CSV import so all paths agree on what
 * "same number" means (issue #212).
 *
 * The canonical key is `normalizePhone` (digits-only) — the same form
 * the DB stores in the generated `contacts.phone_normalized` column
 * and enforces unique per account. `phonesMatch` adds trunk-prefix
 * tolerance (last-8-digit match) for the softer "possible duplicate"
 * surfaces.
 */

/** Canonical de-dup key for a phone string (digits only). */
export function normalizeKey(phone: string): string {
  return normalizePhone(phone);
}

/** Minimal shape we need back from a contacts lookup. */
export interface ExistingContact {
  id: string;
  phone: string;
  name?: string | null;
  [key: string]: unknown;
}

/**
 * Find an existing contact in `accountId` whose phone matches `phone`,
 * or null. Pre-filters in SQL by the last-8-digit suffix (so we don't
 * pull every contact), then applies the strict `phonesMatch` in JS on
 * the small candidate set — the exact approach the webhook has used.
 *
 * Two hardenings over the original version:
 *
 *   - Deterministic tie-break. `phonesMatch`'s trunk-prefix tolerance
 *     (last-8-digit match) means two genuinely different contacts can
 *     both match the same suffix, most plausibly in a multi-country
 *     account. Without an ORDER BY, which candidate won was whatever
 *     order Postgres/PostgREST happened to return — not guaranteed
 *     stable across calls, so the same inbound message could attach
 *     to a different contact run to run. Oldest-first is the same
 *     "canonical survivor" convention already used for conversation
 *     dedup (inbound-pipeline.ts's findOrCreateConversation).
 *   - A query error is logged, not swallowed. It still resolves to
 *     null rather than throwing — every caller here treats null as
 *     "no match, go ahead and create one," and making this throw
 *     would need each of them updated to fail closed instead. Given
 *     that trade-off, the pragmatic middle ground for now is: don't
 *     hide the error (a transient failure manufacturing a duplicate
 *     contact used to be invisible in the logs), while leaving the
 *     fail-open behavior in place until a caller actually needs
 *     fail-closed semantics badly enough to justify the ripple.
 */
export async function findExistingContact(
  db: SupabaseClient,
  accountId: string,
  phone: string,
): Promise<ExistingContact | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;

  const { data, error } = await db
    .from("contacts")
    .select("*")
    .eq("account_id", accountId)
    .like("phone", `%${suffix}`)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[dedupe] findExistingContact query failed:", error.message);
    return null;
  }
  if (!data) return null;

  return (
    (data as ExistingContact[]).find((c) => phonesMatch(c.phone, phone)) ?? null
  );
}

/**
 * True when an existing contact is an *exact* normalized match for
 * `phone` (vs only a fuzzy trunk-variant match). The form hard-blocks
 * exact matches but only warns on fuzzy ones.
 */
export function isExactMatch(existing: ExistingContact, phone: string): boolean {
  return normalizeKey(existing.phone) === normalizeKey(phone);
}

/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505).
 * Used as the backstop when the DB unique index rejects a racing or
 * format-equal insert that slipped past the in-app check.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: string }).code === "23505";
}

/**
 * De-duplicate parsed CSV rows by normalized phone, keeping the first
 * occurrence of each. Rows with an empty normalized phone can't be a
 * valid contact and are dropped too, but counted separately as
 * `invalid` rather than folded into `duplicates` — they never
 * duplicated anything, and the import result should say so instead of
 * telling the user a contact with a real, unique number was skipped
 * as a dupe.
 */
export function dedupeByPhone<T extends { phone: string }>(
  rows: T[],
): { unique: T[]; duplicates: number; invalid: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;
  let invalid = 0;

  for (const row of rows) {
    const key = normalizeKey(row.phone);
    if (!key) {
      invalid++;
      continue;
    }
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(row);
  }

  return { unique, duplicates, invalid };
}
