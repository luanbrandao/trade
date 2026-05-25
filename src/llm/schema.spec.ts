import { describe, it, expect } from 'vitest';
import { TradeDecisionSchema } from './schema';

const base = {
  action: 'BUY',
  confidence: 75,
  stopLossPercent: 2,
  takeProfitPercent: 4,
  timeHorizonMinutes: 60,
  keyRisks: ['macro reversal'],
};

describe('TradeDecisionSchema', () => {
  it('truncates an over-long reason instead of rejecting', () => {
    const longReason = 'x'.repeat(1500);
    const parsed = TradeDecisionSchema.safeParse({ ...base, reason: longReason });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.reason.length).toBe(1000);
  });

  it('keeps a normal-length reason intact', () => {
    const reason = 'EMA9 above EMA21, golden cross, rising volume.';
    const parsed = TradeDecisionSchema.safeParse({ ...base, reason });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.reason).toBe(reason);
  });

  it('truncates over-long keyRisks items', () => {
    const parsed = TradeDecisionSchema.safeParse({
      ...base,
      reason: 'valid rationale here',
      keyRisks: ['y'.repeat(400)],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.keyRisks[0].length).toBe(200);
  });

  it('still rejects a too-short reason', () => {
    const parsed = TradeDecisionSchema.safeParse({ ...base, reason: 'short' });
    expect(parsed.success).toBe(false);
  });
});
