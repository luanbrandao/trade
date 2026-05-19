import { Kline } from '../binance/types';

export function trueRange(curr: Kline, prevClose: number): number {
  const hl = curr.high - curr.low;
  const hc = Math.abs(curr.high - prevClose);
  const lc = Math.abs(curr.low - prevClose);
  return Math.max(hl, hc, lc);
}

export function atr(klines: Kline[], period = 14): number | null {
  if (klines.length < period + 1) return null;

  const trs: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    trs.push(trueRange(klines[i], klines[i - 1].close));
  }

  let atrVal = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const smooth = 2 / (period + 1);
  for (let i = period; i < trs.length; i++) {
    atrVal = trs[i] * smooth + atrVal * (1 - smooth);
  }

  return atrVal;
}
