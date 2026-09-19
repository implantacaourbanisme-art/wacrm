// ============================================================
// SSRF guard for outbound webhook delivery.
//
// A webhook URL is attacker-influenced (any account admin with
// `webhooks:manage` can register one) and our server makes the request,
// so an unguarded fetch is a Server-Side Request Forgery primitive: a
// URL pointing at `127.0.0.1`, a cloud metadata IP (`169.254.169.254`),
// or an RFC1918 host would let a caller probe / POST to internal
// services from the app's network.
//
// `isDeliverableUrl` resolves the host and rejects any address that is
// loopback, private, link-local, ULA, or otherwise non-publicly-
// routable. Combined with `redirect: 'manual'` at the call site (so a
// public URL can't 3xx-bounce to an internal one), this blocks the
// common SSRF vectors.
//
// `resolveSsrfSafeDispatcher` closes the one gap `isDeliverableUrl`
// alone can't: DNS rebinding, where a host resolves public at check
// time and flips to a private address before the ACTUAL connection's
// own (separate) DNS resolution. A caller that only calls
// `isDeliverableUrl` then `fetch(url)` re-resolves DNS a second time at
// connect — exactly the window a rebinding attacker needs. Callers
// that connect to the URL themselves (deliver.ts, the automation
// engine's send_webhook step) should use `resolveSsrfSafeDispatcher`
// instead and pass its result as `fetch`'s `dispatcher` option, which
// pins the connection to the address(es) already verified — no second
// resolution happens. `isDeliverableUrl` stays as a plain yes/no check
// for a caller that validates a URL without ever fetching it itself
// (template-header-handle.ts, where Meta's own servers do the fetch).
// ============================================================

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, type Dispatcher } from 'undici';

/** True for loopback / private / link-local / reserved IPv4 or IPv6. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0) return true; // "this" network
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v6 === '::1' || v6 === '::') return true; // loopback / unspecified
  if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb'))
    return true; // fe80::/10 link-local
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // fc00::/7 ULA
  const mapped = v6.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateOrReservedIp(mapped[1]); // IPv4-mapped
  return false;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Shared resolution behind both isDeliverableUrl and
 * resolveSsrfSafeDispatcher: parse the host, reject an obvious internal
 * name or literal private IP outright, otherwise resolve via DNS and
 * reject if ANY returned address is private/reserved. Returns the
 * verified address list (never empty) on success, or null on any
 * rejection — a malformed URL, an internal name, a private literal, an
 * unresolvable host, or a host with at least one private address.
 */
async function resolvePublicAddresses(rawUrl: string): Promise<ResolvedAddress[] | null> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }

  const ipVersion = isIP(host);
  if (ipVersion) {
    if (isPrivateOrReservedIp(host)) return null;
    return [{ address: host, family: ipVersion === 6 ? 6 : 4 }];
  }

  const lower = host.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return null;
  }

  try {
    const results = await lookup(host, { all: true });
    if (results.length === 0) return null;
    if (!results.every((r) => !isPrivateOrReservedIp(r.address))) return null;
    return results.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
  } catch {
    return null; // unresolvable → not deliverable
  }
}

/**
 * True if `rawUrl`'s host resolves only to publicly-routable
 * address(es). Returns false for a malformed URL, an obvious internal
 * name (`localhost`, `*.local`, `*.internal`), a literal private IP, or
 * a hostname that resolves to any private/reserved address.
 *
 * Only a yes/no check — a caller that goes on to `fetch(rawUrl)` itself
 * re-resolves DNS at connect time, which is the DNS-rebinding gap
 * described at the top of this file. Use
 * `resolveSsrfSafeDispatcher` instead when you're the one connecting.
 */
export async function isDeliverableUrl(rawUrl: string): Promise<boolean> {
  return (await resolvePublicAddresses(rawUrl)) !== null;
}

/**
 * Verify `rawUrl` the same way `isDeliverableUrl` does, and — if it
 * passes — return an undici `Agent` whose connections are pinned to
 * exactly the address(es) just verified, instead of letting `fetch`
 * resolve DNS again at connect time. Pass the result as `dispatcher` to
 * `fetch`. TLS SNI and the `Host` header still use the real hostname —
 * only which IP gets dialed is pinned, so certificate validation is
 * unaffected.
 *
 * Returns null when the URL isn't deliverable — treat identically to a
 * failed `isDeliverableUrl` check.
 */
export async function resolveSsrfSafeDispatcher(rawUrl: string): Promise<Dispatcher | null> {
  const addresses = await resolvePublicAddresses(rawUrl);
  if (!addresses) return null;

  return new Agent({
    connect: {
      lookup: (_hostname, _opts, callback) => {
        callback(null, addresses);
      },
    },
  });
}
