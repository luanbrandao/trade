import { describe, it, expect } from 'vitest';
import { rsi } from './rsi';

describe('rsi', () => {
  it('returns null with insufficient data', () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
    expect(rsi(Array(14).fill(100), 14)).toBeNull();
  });

  it('returns 100 when there are only gains', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi(closes, 14)).toBe(100);
  });

  it('returns near 0 when there are only losses', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    const v = rsi(closes, 14)!;
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it('returns ~50 for alternating equal gains/losses', () => {
    const closes: number[] = [100];
    for (let i = 0; i < 30; i++) closes.push(closes[closes.length - 1] + (i % 2 === 0 ? 1 : -1));
    const v = rsi(closes, 14)!;
    expect(v).toBeGreaterThan(40);
    expect(v).toBeLessThan(60);
  });

  it('matches the classic Wilder reference sequence', () => {
    // Well-known worked example (Wilder's book / StockCharts): first RSI ≈ 70.46
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
      46.28, 46.28,
    ];
    const v = rsi(closes, 14)!;
    expect(v).toBeCloseTo(70.46, 0);
  });
});
