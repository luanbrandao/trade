import { describe, it, expect } from 'vitest';
import { enforceStopVsAtr } from './risk-manager';

describe('enforceStopVsAtr', () => {
  it('passes through when ATR is unavailable', () => {
    const r = enforceStopVsAtr(1, 3, null, 1.0, 2);
    expect(r.ok).toBe(true);
    expect(r.widened).toBe(false);
    expect(r.stopLossPercent).toBe(1);
  });

  it('passes through when stop is already wider than min ATR multiple', () => {
    const r = enforceStopVsAtr(2, 5, 1.5, 1.0, 2); // stop 2% >= 1.5% ATR
    expect(r.ok).toBe(true);
    expect(r.widened).toBe(false);
    expect(r.stopLossPercent).toBe(2);
  });

  it('widens a stop inside ATR noise when R/R still holds', () => {
    // stop 0.5% < 1x ATR 1.5%; widened to 1.5%; TP 4% → R/R 2.67 >= 2 ok
    const r = enforceStopVsAtr(0.5, 4, 1.5, 1.0, 2);
    expect(r.ok).toBe(true);
    expect(r.widened).toBe(true);
    expect(r.stopLossPercent).toBeCloseTo(1.5, 10);
  });

  it('rejects when widening the stop would break the R/R floor', () => {
    // stop 0.5% < 1x ATR 2%; widened stop 2% with TP 3% → R/R 1.5 < 2 → reject
    const r = enforceStopVsAtr(0.5, 3, 2, 1.0, 2);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/R\/R floor/);
  });

  it('respects the multiplier', () => {
    // min stop = 1.5 * 1% ATR = 1.5%; stop 1.2% too tight; TP 6% → widen ok
    const r = enforceStopVsAtr(1.2, 6, 1, 1.5, 2);
    expect(r.ok).toBe(true);
    expect(r.widened).toBe(true);
    expect(r.stopLossPercent).toBeCloseTo(1.5, 10);
  });

  it('disabled when multiplier is 0', () => {
    const r = enforceStopVsAtr(0.5, 1, 5, 0, 2);
    expect(r.ok).toBe(true);
    expect(r.widened).toBe(false);
  });
});
