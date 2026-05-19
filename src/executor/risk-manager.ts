import { SymbolFilters } from '../binance/private-client';

export function floorToStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.floor(value / step) * step;
}

export function ceilToStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.ceil(value / step) * step;
}

export function formatToTick(value: number, tickSize: number): string {
  if (tickSize <= 0) return value.toString();
  const decimals = Math.max(0, -Math.floor(Math.log10(tickSize)));
  return value.toFixed(decimals);
}

export function formatToStep(value: number, stepSize: number): string {
  if (stepSize <= 0) return value.toString();
  const decimals = Math.max(0, -Math.floor(Math.log10(stepSize)));
  return value.toFixed(decimals);
}

export interface RiskPrices {
  takeProfitPrice: number;
  stopPrice: number;
  stopLimitPrice: number;
  rrRatio: number;
}

export function calcRiskPrices(
  avgEntryPrice: number,
  side: 'BUY' | 'SELL',
  stopLossPercent: number,
  takeProfitPercent: number,
  filters: SymbolFilters,
): RiskPrices {
  const isLong = side === 'BUY';

  const rawTp = avgEntryPrice * (1 + (isLong ? takeProfitPercent : -takeProfitPercent) / 100);
  const rawSl = avgEntryPrice * (1 + (isLong ? -stopLossPercent : stopLossPercent) / 100);
  const stopLimitBuffer = 1.005;
  const rawSlLimit = isLong ? rawSl / stopLimitBuffer : rawSl * stopLimitBuffer;

  const takeProfitPrice = floorToStep(rawTp, filters.tickSize || 0.01);
  const stopPrice = floorToStep(rawSl, filters.tickSize || 0.01);
  const stopLimitPrice = floorToStep(rawSlLimit, filters.tickSize || 0.01);

  return {
    takeProfitPrice,
    stopPrice,
    stopLimitPrice,
    rrRatio: takeProfitPercent / stopLossPercent,
  };
}

export function validateRrFloor(rrRatio: number, minRrRatio: number): { ok: boolean; reason?: string } {
  if (rrRatio < minRrRatio) {
    return { ok: false, reason: `R/R ${rrRatio.toFixed(2)}:1 below floor ${minRrRatio}:1` };
  }
  return { ok: true };
}

export function validateMinNotional(quoteQty: number, filters: SymbolFilters): { ok: boolean; reason?: string } {
  if (filters.minNotional > 0 && quoteQty < filters.minNotional) {
    return {
      ok: false,
      reason: `quote qty $${quoteQty} below minNotional $${filters.minNotional}`,
    };
  }
  return { ok: true };
}
