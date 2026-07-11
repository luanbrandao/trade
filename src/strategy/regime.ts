import axios from 'axios';
import { BinancePublicClient } from '../binance/public-client';
import { ema } from '../indicators/ema';

export type Regime = 'RISK_ON' | 'RISK_OFF' | 'CHOPPY' | 'UNKNOWN';

export interface RegimeSnapshot {
  regime: Regime;
  btcTrend: 'UP' | 'DOWN' | 'FLAT';
  btcEma50Slope: number;
  btcChange30dPct: number;
  fearGreedIndex: number | null;
  fearGreedLabel: string | null;
  source: string;
}

let cached: { snap: RegimeSnapshot; ts: number } | null = null;
const CACHE_TTL_MS = 15 * 60_000;

/**
 * Pure regime classification from BTC daily closes (+ optional fear&greed).
 * Shared by live detection and backtest replay so both grade the same way.
 */
export function classifyRegime(
  dailyCloses: number[],
  fearGreed: number | null = null,
  fearGreedLabel: string | null = null,
): RegimeSnapshot {
  const ema50 = ema(dailyCloses, 50);
  const slope =
    ema50.length >= 5
      ? ((ema50[ema50.length - 1] - ema50[ema50.length - 5]) / ema50[ema50.length - 5]) * 100
      : 0;

  const change30d =
    dailyCloses.length >= 30
      ? ((dailyCloses[dailyCloses.length - 1] - dailyCloses[dailyCloses.length - 30]) /
          dailyCloses[dailyCloses.length - 30]) *
        100
      : 0;

  let btcTrend: 'UP' | 'DOWN' | 'FLAT' = 'FLAT';
  if (Math.abs(slope) < 0.5) btcTrend = 'FLAT';
  else if (slope > 0) btcTrend = 'UP';
  else btcTrend = 'DOWN';

  let regime: Regime;
  if (ema50.length === 0) regime = 'UNKNOWN';
  else if (btcTrend === 'UP' && change30d > 5) regime = 'RISK_ON';
  else if (btcTrend === 'DOWN' && change30d < -5) regime = 'RISK_OFF';
  else regime = 'CHOPPY';

  if (fearGreed !== null) {
    if (fearGreed < 25 && regime === 'CHOPPY') regime = 'RISK_OFF';
    if (fearGreed > 75 && regime === 'RISK_ON' && change30d > 15) regime = 'CHOPPY';
  }

  return {
    regime,
    btcTrend,
    btcEma50Slope: slope,
    btcChange30dPct: change30d,
    fearGreedIndex: fearGreed,
    fearGreedLabel,
    source: fearGreed !== null ? 'binance+alternative.me' : 'binance only',
  };
}

export async function detectRegime(pub: BinancePublicClient): Promise<RegimeSnapshot> {
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.snap;
  }

  const klines = await pub.getKlines('BTCUSDT', '1d', 60);
  const closes = klines.map((k) => k.close);
  const fg = await fetchFearGreed();

  const snap = classifyRegime(closes, fg.value, fg.label);

  cached = { snap, ts: Date.now() };
  return snap;
}

async function fetchFearGreed(): Promise<{ value: number | null; label: string | null }> {
  try {
    const { data } = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 3000 });
    const entry = data?.data?.[0];
    if (!entry) return { value: null, label: null };
    return { value: parseInt(entry.value, 10), label: entry.value_classification ?? null };
  } catch {
    return { value: null, label: null };
  }
}

/**
 * Full fear&greed history keyed by UTC day start (ms). Used by the backtest to
 * replay regime with the sentiment data that existed at each candle.
 * Graceful degrade: empty map when the API is unavailable.
 */
export async function fetchFearGreedHistory(): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  try {
    const { data } = await axios.get('https://api.alternative.me/fng/?limit=0', { timeout: 10_000 });
    for (const entry of data?.data ?? []) {
      const ts = parseInt(entry.timestamp, 10) * 1000;
      const value = parseInt(entry.value, 10);
      if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
      const day = new Date(ts);
      const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
      map.set(dayStart, value);
    }
  } catch {
    // sentiment is optional — regime falls back to BTC-only classification
  }
  return map;
}
