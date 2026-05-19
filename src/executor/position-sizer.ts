import { TradeRecord } from '../storage/trades';

export type SizingMode = 'fixed' | 'risk' | 'atr';

export interface SizingInput {
  mode: SizingMode;
  accountEquityUsd: number;
  fixedAmountUsd: number;
  riskPctPerTrade: number;
  entryPrice: number;
  stopLossPercent: number;
  atrAbsolute?: number;
  atrMultiplier?: number;
}

export interface SizingOutput {
  quoteQty: number;
  baseQty: number;
  riskDollars: number;
  effectiveStopPct: number;
  rationale: string;
}

export function sizePosition(input: SizingInput): SizingOutput {
  switch (input.mode) {
    case 'fixed':
      return sizeFixed(input);
    case 'risk':
      return sizeRisk(input);
    case 'atr':
      return sizeAtr(input);
  }
}

function sizeFixed(input: SizingInput): SizingOutput {
  const quoteQty = input.fixedAmountUsd;
  const baseQty = quoteQty / input.entryPrice;
  const riskDollars = quoteQty * (input.stopLossPercent / 100);
  return {
    quoteQty,
    baseQty,
    riskDollars,
    effectiveStopPct: input.stopLossPercent,
    rationale: `fixed $${input.fixedAmountUsd}`,
  };
}

function sizeRisk(input: SizingInput): SizingOutput {
  const riskDollars = input.accountEquityUsd * (input.riskPctPerTrade / 100);
  const stopDistanceUsd = input.entryPrice * (input.stopLossPercent / 100);
  const baseQty = riskDollars / stopDistanceUsd;
  const quoteQty = baseQty * input.entryPrice;
  return {
    quoteQty,
    baseQty,
    riskDollars,
    effectiveStopPct: input.stopLossPercent,
    rationale: `risk ${input.riskPctPerTrade}% of $${input.accountEquityUsd} = $${riskDollars.toFixed(2)} / ${input.stopLossPercent}% stop`,
  };
}

function sizeAtr(input: SizingInput): SizingOutput {
  if (!input.atrAbsolute || !input.atrMultiplier) {
    throw new Error('ATR sizing requires atrAbsolute + atrMultiplier');
  }
  const stopDistanceUsd = input.atrAbsolute * input.atrMultiplier;
  const effectiveStopPct = (stopDistanceUsd / input.entryPrice) * 100;
  const riskDollars = input.accountEquityUsd * (input.riskPctPerTrade / 100);
  const baseQty = riskDollars / stopDistanceUsd;
  const quoteQty = baseQty * input.entryPrice;
  return {
    quoteQty,
    baseQty,
    riskDollars,
    effectiveStopPct,
    rationale: `ATR(${input.atrAbsolute.toFixed(4)}) * ${input.atrMultiplier} = $${stopDistanceUsd.toFixed(2)} stop, risk ${input.riskPctPerTrade}%`,
  };
}

export function currentPortfolioHeatPct(openTrades: TradeRecord[], accountEquityUsd: number): number {
  if (accountEquityUsd <= 0) return 0;
  const totalRiskUsd = openTrades.reduce((sum, t) => {
    if (t.slPrice == null) return sum;
    const stopDist = Math.abs(t.avgPrice - t.slPrice);
    return sum + stopDist * t.qty;
  }, 0);
  return (totalRiskUsd / accountEquityUsd) * 100;
}

export function checkHeatCap(
  prospectiveRiskUsd: number,
  openTrades: TradeRecord[],
  accountEquityUsd: number,
  maxHeatPct: number,
): { ok: boolean; currentPct: number; projectedPct: number; reason?: string } {
  const currentPct = currentPortfolioHeatPct(openTrades, accountEquityUsd);
  const projectedPct = currentPct + (prospectiveRiskUsd / accountEquityUsd) * 100;
  if (projectedPct > maxHeatPct) {
    return {
      ok: false,
      currentPct,
      projectedPct,
      reason: `portfolio heat ${projectedPct.toFixed(2)}% > cap ${maxHeatPct}% (current ${currentPct.toFixed(2)}%)`,
    };
  }
  return { ok: true, currentPct, projectedPct };
}
