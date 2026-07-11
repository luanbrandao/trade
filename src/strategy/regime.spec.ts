import { describe, it, expect } from 'vitest';
import { classifyRegime } from './regime';

function trendCloses(start: number, dailyPct: number, days: number): number[] {
  const closes: number[] = [start];
  for (let i = 1; i < days; i++) closes.push(closes[i - 1] * (1 + dailyPct / 100));
  return closes;
}

describe('classifyRegime', () => {
  it('classifies a strong uptrend as RISK_ON', () => {
    const closes = trendCloses(50000, 0.6, 60); // ~+43% over 60d
    const r = classifyRegime(closes);
    expect(r.regime).toBe('RISK_ON');
    expect(r.btcTrend).toBe('UP');
  });

  it('classifies a strong downtrend as RISK_OFF', () => {
    const closes = trendCloses(50000, -0.6, 60);
    const r = classifyRegime(closes);
    expect(r.regime).toBe('RISK_OFF');
    expect(r.btcTrend).toBe('DOWN');
  });

  it('classifies a flat market as CHOPPY', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 50000 + (i % 2 === 0 ? 100 : -100));
    const r = classifyRegime(closes);
    expect(r.regime).toBe('CHOPPY');
    expect(r.btcTrend).toBe('FLAT');
  });

  it('returns UNKNOWN with insufficient history for EMA50', () => {
    const r = classifyRegime(trendCloses(50000, 0.5, 30));
    expect(r.regime).toBe('UNKNOWN');
  });

  it('extreme fear flips CHOPPY to RISK_OFF', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 50000 + (i % 2 === 0 ? 100 : -100));
    const r = classifyRegime(closes, 10, 'Extreme Fear');
    expect(r.regime).toBe('RISK_OFF');
    expect(r.fearGreedIndex).toBe(10);
  });

  it('extreme greed on an overheated market flips RISK_ON to CHOPPY', () => {
    const closes = trendCloses(50000, 0.6, 60); // 30d change > 15%
    const r = classifyRegime(closes, 90, 'Extreme Greed');
    expect(r.regime).toBe('CHOPPY');
  });
});
