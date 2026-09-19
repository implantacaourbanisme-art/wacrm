import { describe, it, expect } from 'vitest';
import { isPrivateOrReservedIp, isDeliverableUrl, resolveSsrfSafeDispatcher } from './ssrf';

describe('isPrivateOrReservedIp', () => {
  it('flags loopback / private / link-local / CGNAT IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it('flags loopback / ULA / link-local IPv6 and IPv4-mapped privates', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::34', '::ffff:127.0.0.1']) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('isDeliverableUrl', () => {
  it('rejects literal private IPs and internal names without DNS', async () => {
    expect(await isDeliverableUrl('https://127.0.0.1/hook')).toBe(false);
    expect(await isDeliverableUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(await isDeliverableUrl('https://[::1]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://localhost/hook')).toBe(false);
    expect(await isDeliverableUrl('https://foo.internal/hook')).toBe(false);
  });

  it('rejects a malformed URL', async () => {
    expect(await isDeliverableUrl('not a url')).toBe(false);
  });

  it('allows a literal public IP', async () => {
    expect(await isDeliverableUrl('https://8.8.8.8/hook')).toBe(true);
  });
});

describe('resolveSsrfSafeDispatcher', () => {
  it('returns null for the same rejections isDeliverableUrl applies', async () => {
    expect(await resolveSsrfSafeDispatcher('https://127.0.0.1/hook')).toBeNull();
    expect(await resolveSsrfSafeDispatcher('https://169.254.169.254/latest/meta-data')).toBeNull();
    expect(await resolveSsrfSafeDispatcher('https://localhost/hook')).toBeNull();
    expect(await resolveSsrfSafeDispatcher('https://foo.internal/hook')).toBeNull();
    expect(await resolveSsrfSafeDispatcher('not a url')).toBeNull();
  });

  it('returns a closeable dispatcher pinned to a public literal IP, not a boolean', async () => {
    const dispatcher = await resolveSsrfSafeDispatcher('https://8.8.8.8/hook');
    expect(dispatcher).not.toBeNull();
    expect(typeof dispatcher?.close).toBe('function');
    await dispatcher?.close();
  });
});
