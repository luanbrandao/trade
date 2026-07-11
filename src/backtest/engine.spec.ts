import { describe, it, expect } from 'vitest';
import { resampleKlines, makeRegimeLookup } from './engine';
import { Kline } from '../binance/types';

const H = 3_600_000;
const D = 86_400_000;

function k(openTime: number, open: number, high: number, low: number, close: number, volume = 10): Kline {
  return { openTime, open, high, low, close, volume, closeTime: openTime + H - 1, trades: 1 } as Kline;
}

describe('resampleKlines', () => {
  it('aggregates 1h candles into 4h buckets', () => {
    const klines = [
      k(0, 100, 110, 95, 105),
      k(H, 105, 120, 100, 115),
      k(2 * H, 115, 118, 90, 95),
      k(3 * H, 95, 100, 92, 98),
      k(4 * H, 98, 99, 97, 98), // next bucket
    ];
    const out = resampleKlines(klines, 4 * H);
    expect(out).toHaveLength(2);
    expect(out[0].open).toBe(100);
    expect(out[0].high).toBe(120);
    expect(out[0].low).toBe(90);
    expect(out[0].close).toBe(98);
    expect(out[0].volume).toBe(40);
    expect(out[1].open).toBe(98);
  });

  it('handles empty input', () => {
    expect(resampleKlines([], 4 * H)).toHaveLength(0);
  });
});

describe('makeRegimeLookup', () => {
  function dailies(days: number, dailyPct: number): Kline[] {
    const out: Kline[] = [];
    let price = 50000;
    for (let i = 0; i < days; i++) {
      const open = price;
      price = price * (1 + dailyPct / 100);
      out.push({
        openTime: i * D,
        closeTime: (i + 1) * D - 1,
        open,
        high: Math.max(open, price),
        low: Math.min(open, price),
        close: price,
        volume: 1,
        trades: 1,
      } as Kline);
    }
    return out;
  }

  it('returns undefined before enough BTC history exists', () => {
    const lookup = makeRegimeLookup(dailies(80, 0.5), new Map());
    expect(lookup(10 * D)).toBeUndefined();
  });

  it('classifies once history is sufficient and memoizes per day', () => {
    const lookup = makeRegimeLookup(dailies(80, 0.5), new Map());
    const ts = 70 * D + 5 * H;
    const first = lookup(ts);
    expect(first).toBeDefined();
    expect(first!.regime).toBe('RISK_ON');
    expect(lookup(70 * D + 10 * H)).toBe(first); // same UTC day → memoized object
  });

  it('only uses candles closed before the timestamp (no look-ahead)', () => {
    const up = dailies(80, 0.5);
    // Make the last 10 days crash hard; a lookup at day 65 must not see it.
    for (let i = 70; i < 80; i++) {
      up[i] = { ...up[i], close: up[i].close * 0.5 };
    }
    const lookup = makeRegimeLookup(up, new Map());
    expect(lookup(65 * D + H)!.regime).toBe('RISK_ON');
  });

  it('applies fear&greed for the matching day', () => {
    const flat: Kline[] = [];
    for (let i = 0; i < 80; i++) {
      const price = 50000 + (i % 2 === 0 ? 100 : -100);
      flat.push({
        openTime: i * D,
        closeTime: (i + 1) * D - 1,
        open: price,
        high: price + 10,
        low: price - 10,
        close: price,
        volume: 1,
        trades: 1,
      } as Kline);
    }
    const fg = new Map<number, number>([[70 * D, 10]]); // extreme fear that day
    const lookup = makeRegimeLookup(flat, fg);
    expect(lookup(70 * D + H)!.regime).toBe('RISK_OFF');
  });
});
