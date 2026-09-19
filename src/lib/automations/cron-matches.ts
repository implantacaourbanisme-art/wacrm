import { CronExpressionParser } from 'cron-parser'

/**
 * Returns true if the given cron schedule had a scheduled firing inside the
 * [now - windowMs, now] window (inclusive of `now`).
 *
 * The cron endpoint calls this with a 65-second window so a 1-minute
 * schedule check never misses a tick even when invocations drift slightly.
 *
 * Implementation note: `CronExpressionParser.parse` with `currentDate = D`
 * treats D as *exclusive* when calling `.prev()` — a tick *exactly* at D is
 * skipped. We therefore add 1 ms to `now` so that a tick at `now` itself is
 * included in the window.
 *
 * Accepts standard 5-field cron expressions (minute hour dom month dow) as
 * well as a bare "HH:mm" shorthand (converted to `m h * * *` internally so
 * the UI's placeholder of "e.g. 0 9 * * 1-5" and "09:00" both work).
 *
 * Returns false — rather than throwing — for unparseable expressions so a
 * bad schedule stored by an older version of the builder never kills the
 * whole cron sweep.
 */
export function cronMatchedInWindow(
  schedule: string,
  windowMs: number,
  now: Date = new Date(),
): boolean {
  try {
    const expr = normalise(schedule.trim())
    // Add 1 ms so a tick that landed exactly at `now` is included by prev().
    const cursor = new Date(now.getTime() + 1)
    const interval = CronExpressionParser.parse(expr, {
      currentDate: cursor,
    })
    const prev = interval.prev().toDate()
    return now.getTime() - prev.getTime() <= windowMs
  } catch {
    return false
  }
}

/** Normalise a bare "HH:mm" string to a standard 5-field cron expression. */
function normalise(raw: string): string {
  // Already looks like a cron expression (contains a space or wildcard)
  if (raw.includes(' ') || raw.includes('*') || raw.includes('/')) return raw

  // "HH:mm" → "mm HH * * *"
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw)
  if (match) {
    const h = parseInt(match[1], 10)
    const m = parseInt(match[2], 10)
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${m} ${h} * * *`
    }
  }
  return raw
}
