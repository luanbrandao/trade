import { Kline } from '../binance/types';

export interface SupportResistance {
  /** Swing lows below current price, closest first. */
  supports: number[];
  /** Swing highs above current price, closest first. */
  resistances: number[];
  periodHigh: number;
  periodLow: number;
}

/**
 * Pivot-based support/resistance. A swing high is a candle whose high exceeds
 * the highs of `lookback` candles on each side (swing low symmetric on lows).
 * Levels within `mergeTolerancePct` of each other collapse into one (keeps the
 * more recent touch), so clusters of pivots read as a single level.
 */
export function supportResistance(
  klines: Kline[],
  currentPrice: number,
  lookback = 3,
  maxLevels = 3,
  mergeTolerancePct = 0.25,
): SupportResistance | null {
  if (klines.length < lookback * 2 + 1) return null;

  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = lookback; i < klines.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (klines[j].high >= klines[i].high) isHigh = false;
      if (klines[j].low <= klines[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swingHighs.push(klines[i].high);
    if (isLow) swingLows.push(klines[i].low);
  }

  const merge = (levels: number[]): number[] => {
    const out: number[] = [];
    for (const lv of levels) {
      const dup = out.findIndex((o) => Math.abs(o - lv) / o * 100 <= mergeTolerancePct);
      if (dup >= 0) out[dup] = lv;
      else out.push(lv);
    }
    return out;
  };

  const supports = merge(swingLows)
    .filter((l) => l < currentPrice)
    .sort((a, b) => b - a)
    .slice(0, maxLevels);
  const resistances = merge(swingHighs)
    .filter((l) => l > currentPrice)
    .sort((a, b) => a - b)
    .slice(0, maxLevels);

  return {
    supports,
    resistances,
    periodHigh: Math.max(...klines.map((k) => k.high)),
    periodLow: Math.min(...klines.map((k) => k.low)),
  };
}

/**
 * Last candle volume relative to the average of the preceding `period` candles.
 * 1.0 = average, 2.0 = double average. Null when not enough data.
 */
export function relativeVolume(klines: Kline[], period = 20): number | null {
  if (klines.length < period + 1) return null;
  const prior = klines.slice(-period - 1, -1);
  const avg = prior.reduce((s, k) => s + k.volume, 0) / period;
  if (avg <= 0) return null;
  return klines[klines.length - 1].volume / avg;
}
