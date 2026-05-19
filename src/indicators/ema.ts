export function ema(values: number[], period: number): number[] {
  if (period <= 0) throw new Error('period must be > 0');
  if (values.length < period) return [];

  const k = 2 / (period + 1);
  const result: number[] = [];

  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(prev);

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }

  return result;
}

export function emaLast(values: number[], period: number): number | null {
  const series = ema(values, period);
  return series.length > 0 ? series[series.length - 1] : null;
}

export type EmaCross = 'GOLDEN' | 'DEATH' | 'NONE';

export interface EmaState {
  fast: number;
  slow: number;
  prevFast: number;
  prevSlow: number;
  cross: EmaCross;
  trend: 'UP' | 'DOWN' | 'FLAT';
}

export function emaState(
  closes: number[],
  fastPeriod = 9,
  slowPeriod = 21,
): EmaState | null {
  if (closes.length < slowPeriod + 1) return null;

  const fastSeries = ema(closes, fastPeriod);
  const slowSeries = ema(closes, slowPeriod);

  const offsetDiff = fastSeries.length - slowSeries.length;
  const fAligned = offsetDiff >= 0 ? fastSeries.slice(offsetDiff) : fastSeries;
  const sAligned = offsetDiff >= 0 ? slowSeries : slowSeries.slice(-offsetDiff);

  if (fAligned.length < 2 || sAligned.length < 2) return null;

  const fast = fAligned[fAligned.length - 1];
  const slow = sAligned[sAligned.length - 1];
  const prevFast = fAligned[fAligned.length - 2];
  const prevSlow = sAligned[sAligned.length - 2];

  let cross: EmaCross = 'NONE';
  if (prevFast <= prevSlow && fast > slow) cross = 'GOLDEN';
  else if (prevFast >= prevSlow && fast < slow) cross = 'DEATH';

  let trend: 'UP' | 'DOWN' | 'FLAT' = 'FLAT';
  const spreadPct = Math.abs((fast - slow) / slow) * 100;
  if (spreadPct < 0.05) trend = 'FLAT';
  else if (fast > slow) trend = 'UP';
  else trend = 'DOWN';

  return { fast, slow, prevFast, prevSlow, cross, trend };
}
