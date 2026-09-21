import { describe, it, expect } from 'vitest';
import {
  ZAPI_SEND_DELAY_MIN_MS,
  ZAPI_SEND_DELAY_MAX_MS,
  pacingDelayMs,
  broadcastSendPlan,
} from './send-pacing';

describe('pacingDelayMs', () => {
  it('exposes the 3-8 s range', () => {
    expect(ZAPI_SEND_DELAY_MIN_MS).toBe(3000);
    expect(ZAPI_SEND_DELAY_MAX_MS).toBe(8000);
  });

  it('zapi: rand 0 gives the minimum, rand 0.999... gives the maximum (inclusive)', () => {
    expect(pacingDelayMs('zapi', () => 0)).toBe(3000);
    expect(pacingDelayMs('zapi', () => 0.9999999999)).toBe(8000);
  });

  it('zapi: always an integer within range', () => {
    for (let i = 0; i < 200; i++) {
      const d = pacingDelayMs('zapi');
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(3000);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });

  it('meta / null / undefined: no delay', () => {
    expect(pacingDelayMs('meta')).toBe(0);
    expect(pacingDelayMs(null)).toBe(0);
    expect(pacingDelayMs(undefined)).toBe(0);
  });
});

describe('broadcastSendPlan', () => {
  it('zapi sends one at a time with a fresh random delay', () => {
    const plan = broadcastSendPlan('zapi');
    expect(plan.batchSize).toBe(1);
    const d = plan.delayMs();
    expect(d).toBeGreaterThanOrEqual(3000);
    expect(d).toBeLessThanOrEqual(8000);
  });

  it.each(['meta', null, undefined] as const)('%s keeps 10 per batch / 1 s', (kind) => {
    const plan = broadcastSendPlan(kind);
    expect(plan.batchSize).toBe(10);
    expect(plan.delayMs()).toBe(1000);
  });
});
