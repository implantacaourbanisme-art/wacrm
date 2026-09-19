/**
 * Dual-backend rate limiter: Upstash Redis when configured, in-process
 * Map otherwise.
 *
 * ── Why two backends? ────────────────────────────────────────────────
 * The original in-memory Map is correct for a single-instance VPS but
 * silently defeats itself on horizontal scale: each process owns its
 * own Map, so the effective limit multiplies by the number of instances.
 * Upstash Redis stores counters atomically across every instance of the
 * app, whether that's two Fly.io machines or hundreds of Vercel lambdas.
 *
 * ── Selecting the backend ───────────────────────────────────────────
 * Set both env vars to enable Redis:
 *   UPSTASH_REDIS_REST_URL=https://…upstash.io
 *   UPSTASH_REDIS_REST_TOKEN=AX…
 * Without them the module falls back to the in-memory implementation
 * automatically — no code change, no crash, no 503 on startup.
 *
 * ── API surface ─────────────────────────────────────────────────────
 * `checkRateLimit` is now async. All public shapes (RateLimitOptions,
 * RateLimitResult, RATE_LIMITS, rateLimitResponse) are unchanged; call
 * sites only need `await` in front of checkRateLimit(…).
 *
 * ── Algorithm ───────────────────────────────────────────────────────
 * Fixed-window in both backends for simplicity and predictability.
 * Upstash's SlidingWindow is more accurate but adds a second Redis
 * round-trip; fixed-window is fine for the 1-minute windows used here.
 */

import { NextResponse } from 'next/server'

// ── Types (unchanged public surface) ────────────────────────────────

export interface RateLimitOptions {
  /** Max requests allowed in `windowMs`. */
  limit: number
  /** Window size, milliseconds. */
  windowMs: number
}

export interface RateLimitResult {
  success: boolean
  /** Requests still allowed in the current window. */
  remaining: number
  /** Unix ms when the bucket refills. */
  reset: number
  limit: number
}

// ── Upstash Redis backend ────────────────────────────────────────────

/**
 * Lazy Upstash client + limiter cache. We build one Ratelimit instance
 * per (limit, windowMs) pair because @upstash/ratelimit bakes the
 * window size into the instance at construction time. With ~10 distinct
 * RATE_LIMITS entries the cache stays tiny.
 */
type UpstashRatelimit = import('@upstash/ratelimit').Ratelimit

let _upstashRatelimitCache: Map<string, UpstashRatelimit> | null = null

function upstashKey(opts: RateLimitOptions) {
  return `${opts.limit}:${opts.windowMs}`
}

async function getUpstashLimiter(
  opts: RateLimitOptions,
): Promise<UpstashRatelimit | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null

  try {
    const { Ratelimit } = await import('@upstash/ratelimit')
    const { Redis } = await import('@upstash/redis')

    if (!_upstashRatelimitCache) _upstashRatelimitCache = new Map()
    const k = upstashKey(opts)
    if (!_upstashRatelimitCache.has(k)) {
      const redis = new Redis({ url, token })
      _upstashRatelimitCache.set(
        k,
        new Ratelimit({
          redis,
          limiter: Ratelimit.fixedWindow(opts.limit, `${opts.windowMs} ms`),
          // Prefix keeps wacrm's keys from colliding with other apps
          // sharing the same Upstash database.
          prefix: 'wacrm_rl',
          // Don't wait for the analytics write — keep latency low.
          analytics: false,
        }),
      )
    }
    return _upstashRatelimitCache.get(k)!
  } catch (err) {
    // Gracefully degrade: if the import or constructor fails (e.g. bad
    // credentials at startup), fall through to the in-memory backend
    // rather than crashing the request handler.
    console.error('[rate-limit] Upstash init failed, falling back to in-memory:', err)
    return null
  }
}

async function checkUpstash(
  key: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult | null> {
  const limiter = await getUpstashLimiter(opts)
  if (!limiter) return null

  try {
    const result = await limiter.limit(key)
    return {
      success: result.success,
      remaining: result.remaining,
      reset: result.reset, // Unix ms
      limit: result.limit,
    }
  } catch (err) {
    // Upstash unavailable (network blip, cold-start timeout, …).
    // Fail open: fall through to in-memory rather than blocking every
    // request while Redis is down. A brief in-memory window keeps the
    // feature mostly working.
    console.error('[rate-limit] Upstash limit() failed, falling back to in-memory:', err)
    return null
  }
}

// ── In-memory backend (fallback / single-instance) ──────────────────

interface Entry {
  count: number
  resetAt: number
}

const buckets = new Map<string, Entry>()
const LIGHT_SWEEP_EVERY = 1000
let callsSinceSweep = 0

function sweepExpired(now: number) {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k)
  }
}

function checkInMemory(key: string, { limit, windowMs }: RateLimitOptions): RateLimitResult {
  const now = Date.now()
  callsSinceSweep += 1
  if (callsSinceSweep >= LIGHT_SWEEP_EVERY) {
    callsSinceSweep = 0
    sweepExpired(now)
  }

  const entry = buckets.get(key)
  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { success: true, remaining: limit - 1, reset: now + windowMs, limit }
  }
  if (entry.count >= limit) {
    return { success: false, remaining: 0, reset: entry.resetAt, limit }
  }
  entry.count += 1
  return { success: true, remaining: limit - entry.count, reset: entry.resetAt, limit }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Check and consume one request token for `key`.
 *
 * Uses Upstash Redis when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 * are set; falls back to in-process Map otherwise (safe for single-instance
 * deploys, silent on startup without the env vars).
 */
export async function checkRateLimit(
  key: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const upstash = await checkUpstash(key, opts)
  if (upstash) return upstash
  return checkInMemory(key, opts)
}

/**
 * Standard 429 response with the headers clients expect (RFC 6585 +
 * draft-ietf-httpapi-ratelimit-headers). Callers just `return` this.
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000))
  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      retry_after_seconds: retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
      },
    },
  )
}

/** Preconfigured budgets — tweak here, not at call sites. */
export const RATE_LIMITS = {
  /** Individual message send. 60/min per user = one per second sustained. */
  send: { limit: 60, windowMs: 60_000 },
  /** Manual automation trigger — same cost class as `send`. */
  automationsEngine: { limit: 60, windowMs: 60_000 },
  /** Broadcast batches. The wizard fans out in batches of 10, ~1/s. */
  broadcast: { limit: 60, windowMs: 60_000 },
  /** Reactions — permissive; a swap is two calls under the hood. */
  react: { limit: 120, windowMs: 60_000 },
  /** Invitation peek (public, per-IP). */
  invitationPeek: { limit: 30, windowMs: 60_000 },
  /** Invitation redeem (authed, per-IP+user). */
  invitationRedeem: { limit: 10, windowMs: 60_000 },
  /** Admin account / member management actions. */
  adminAction: { limit: 30, windowMs: 60_000 },
  /** Public REST API (/api/v1/*), per API key. */
  publicApi: { limit: 120, windowMs: 60_000 },
  /** AI draft-reply generation, per user. */
  aiDraft: { limit: 20, windowMs: 60_000 },
  /** AI draft-reply generation, per account (shared BYO key cap). */
  aiDraftAccount: { limit: 60, windowMs: 60_000 },
  /** AI auto-reply, per account — bounds stampedes across threads. */
  aiAutoReplyAccount: { limit: 30, windowMs: 60_000 },
} as const

/** Test-only: clear in-memory state between tests. Also clears the
 *  Upstash limiter cache so tests that mock env vars get a fresh client. */
export function __resetRateLimitForTests() {
  buckets.clear()
  callsSinceSweep = 0
  _upstashRatelimitCache = null
}
