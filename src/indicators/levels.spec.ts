import { describe, it, expect } from 'vitest';
import { supportResistance, relativeVolume } from './levels';
import { Kline } from '../binance/types';

function k(openTime: number, open: number, high: number, low: number, close: number, volume = 10): Kline {
  return { openTime, open, high, low, close, volume, closeTime: openTime + 3599999, trades: 1 } as Kline;
}

describe('supportResistance', () => {
  it('returns null with insufficient candles', () => {
    expect(supportResistance([k(0, 1, 2, 0.5, 1)], 1)).toBeNull();
  });

  it('detects swing high above and swing low below current price', () => {
    // Build a valley then a peak: swing low at 90, swing high at 120, price now 100.
    const klines = [
      k(0, 100, 101, 99, 100),
      k(1, 100, 100, 95, 96),
      k(2, 96, 97, 94, 95),
      k(3, 95, 96, 90, 91), // swing low: 90
      k(4, 91, 97, 91, 96),
      k(5, 96, 103, 96, 102),
      k(6, 102, 110, 102, 109),
      k(7, 109, 120, 109, 118), // swing high: 120
      k(8, 118, 117, 108, 110),
      k(9, 110, 111, 105, 106),
      k(10, 106, 107, 99, 100),
    ];
    const sr = supportResistance(klines, 100, 3)!;
    expect(sr.supports).toContain(90);
    expect(sr.resistances).toContain(120);
    expect(sr.periodHigh).toBe(120);
    expect(sr.periodLow).toBe(90);
  });

  it('orders supports descending (closest first) and resistances ascending', () => {
    const klines: Kline[] = [];
    let t = 0;
    // Two valleys at 80 and 90, two peaks at 120 and 130, ending at 100.
    const path = [100, 95, 80, 95, 100, 110, 120, 110, 100, 95, 90, 95, 105, 118, 130, 118, 105, 100, 100, 100];
    for (const p of path) klines.push(k(t++, p, p + 1, p - 1, p));
    const sr = supportResistance(klines, 100, 2)!;
    for (let i = 1; i < sr.supports.length; i++) {
      expect(sr.supports[i]).toBeLessThan(sr.supports[i - 1]);
    }
    for (let i = 1; i < sr.resistances.length; i++) {
      expect(sr.resistances[i]).toBeGreaterThan(sr.resistances[i - 1]);
    }
  });
});

describe('relativeVolume', () => {
  it('returns null with insufficient candles', () => {
    expect(relativeVolume([k(0, 1, 2, 0.5, 1)], 20)).toBeNull();
  });

  it('computes last volume vs prior average', () => {
    const klines: Kline[] = [];
    for (let i = 0; i < 20; i++) klines.push(k(i, 1, 2, 0.5, 1, 10));
    klines.push(k(20, 1, 2, 0.5, 1, 25)); // 25 vs avg 10 = 2.5x
    expect(relativeVolume(klines, 20)).toBeCloseTo(2.5, 5);
  });

  it('returns 1.0 for flat volume', () => {
    const klines: Kline[] = [];
    for (let i = 0; i < 25; i++) klines.push(k(i, 1, 2, 0.5, 1, 7));
    expect(relativeVolume(klines, 20)).toBeCloseTo(1, 5);
  });
});
