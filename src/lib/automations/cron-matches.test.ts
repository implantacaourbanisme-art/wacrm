import { describe, it, expect } from 'vitest'
import { cronMatchedInWindow } from './cron-matches'

// All reference dates are anchored to exact cron-tick moments expressed in
// UTC so the tests are deterministic regardless of the server's local TZ.
//
// The helper uses cron-parser WITHOUT utc:true (server-local time), so a
// schedule "0 9 * * *" fires at 09:00 local, which in UTC is:
//   UTC-3  → 12:00 UTC
//   UTC    → 09:00 UTC
//   UTC+1  → 08:00 UTC
//
// To avoid TZ-sensitive expectations we pin the tests around "*-minute*" and
// "*-second*" expressions that are absolute in UTC (e.g. "*/5 * * * *" — a
// 5-min cron fires on the minute boundary, same instant in every TZ), plus
// a local-hour-agnostic trick: anchor REF to the moment that the server's
// local clock would actually show as the trigger firing.

// Build a reference instant that IS a local 09:00 (whatever the server TZ
// offset is), so "0 9 * * *" / "0 9 * * 1-5" both fire at REF exactly.
function localNineAM(isoDate: string): Date {
  // Parse date components, build a local midnight, then add 9 hours.
  const [y, mo, d] = isoDate.split('-').map(Number)
  const local = new Date(y, mo - 1, d, 9, 0, 0, 0) // local time
  return local
}

// 2024-03-15 is a Friday in any TZ (UTC day-of-week = 5).
const REF_FRIDAY = localNineAM('2024-03-15')
const ONE_MIN = 65_000

describe('cronMatchedInWindow', () => {
  it('matches when the last tick is within the window', () => {
    // "every day at 09:00 local" — prev() at REF_FRIDAY is exactly 09:00.
    expect(cronMatchedInWindow('0 9 * * *', ONE_MIN, REF_FRIDAY)).toBe(true)
  })

  it('does not match when the last tick is outside the window', () => {
    // "every day at 10:00 local" — prev() at local 09:00 is yesterday 10:00 → far outside.
    expect(cronMatchedInWindow('0 10 * * *', ONE_MIN, REF_FRIDAY)).toBe(false)
  })

  it('matches a cron that fired a few seconds ago (tick at :58, now at :01)', () => {
    // The minute-boundary anchor: use a UTC-fixed tick. "58 * * * *" fires at
    // HH:58 in local time. Build "now" = HH:58 + 63 s so it is within the window.
    const base = new Date(REF_FRIDAY)
    // go to the :58 tick of the current local hour (08:58 → REF_FRIDAY is 09:00 local)
    base.setMinutes(58, 0, 0) // 08:58:00 local
    const justAfter = new Date(base.getTime() + 63_000) // 08:59:03 local → within 65 s of :58
    expect(cronMatchedInWindow('58 * * * *', ONE_MIN, justAfter)).toBe(true)
  })

  it('accepts HH:mm shorthand (UI placeholder format)', () => {
    // "09:00" → "0 9 * * *" — should match exactly at local 09:00.
    expect(cronMatchedInWindow('09:00', ONE_MIN, REF_FRIDAY)).toBe(true)
  })

  it('HH:mm shorthand outside window returns false', () => {
    expect(cronMatchedInWindow('10:00', ONE_MIN, REF_FRIDAY)).toBe(false)
  })

  it('returns false for an unparseable expression (bad cron in DB)', () => {
    expect(cronMatchedInWindow('not a cron', ONE_MIN, REF_FRIDAY)).toBe(false)
  })

  it('matches weekday-restricted cron on matching day (Friday)', () => {
    // "09:00 Mon–Fri" — REF_FRIDAY is a Friday.
    expect(cronMatchedInWindow('0 9 * * 1-5', ONE_MIN, REF_FRIDAY)).toBe(true)
  })

  it('does not match weekday-restricted cron on non-matching day', () => {
    // Saturday 09:00 local.
    const saturday = localNineAM('2024-03-16') // 2024-03-16 is a Saturday
    expect(cronMatchedInWindow('0 9 * * 1-5', ONE_MIN, saturday)).toBe(false)
  })

  it('matches high-frequency cron (every 5 minutes) within window', () => {
    // "*/5 * * * *" fires on every :00, :05, :10, …, :55 of every hour.
    // REF_FRIDAY is at :00 → last tick is at :00 itself → within 65 s.
    expect(cronMatchedInWindow('*/5 * * * *', ONE_MIN, REF_FRIDAY)).toBe(true)
  })
})

