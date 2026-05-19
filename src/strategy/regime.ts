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

export async function detectRegime(pub: BinancePublicClient): Promise<RegimeSnapshot> {
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.snap;
  }

  const klines = await pub.getKlines('BTCUSDT', '1d', 60);
  const closes = klines.map((k) => k.close);

  const ema50 = ema(closes, 50);
  const slope =
    ema50.length >= 5
      ? ((ema50[ema50.length - 1] - ema50[ema50.length - 5]) / ema50[ema50.length - 5]) * 100
      : 0;

  const change30d =
    closes.length >= 30
      ? ((closes[closes.length - 1] - closes[closes.length - 30]) / closes[closes.length - 30]) * 100
      : 0;

  let btcTrend: 'UP' | 'DOWN' | 'FLAT' = 'FLAT';
  if (Math.abs(slope) < 0.5) btcTrend = 'FLAT';
  else if (slope > 0) btcTrend = 'UP';
  else btcTrend = 'DOWN';

  const fg = await fetchFearGreed();

  let regime: Regime;
  if (btcTrend === 'UP' && change30d > 5) regime = 'RISK_ON';
  else if (btcTrend === 'DOWN' && change30d < -5) regime = 'RISK_OFF';
  else regime = 'CHOPPY';

  if (fg.value !== null) {
    if (fg.value < 25 && regime === 'CHOPPY') regime = 'RISK_OFF';
    if (fg.value > 75 && regime === 'RISK_ON' && change30d > 15) regime = 'CHOPPY';
  }

  const snap: RegimeSnapshot = {
    regime,
    btcTrend,
    btcEma50Slope: slope,
    btcChange30dPct: change30d,
    fearGreedIndex: fg.value,
    fearGreedLabel: fg.label,
    source: fg.value !== null ? 'binance+alternative.me' : 'binance only',
  };

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
