import { TradeDecision } from '../llm/schema';
import { MarketSnapshot, PromptContext } from '../llm/prompt';

export interface MockDecideOutput {
  decision: TradeDecision;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function mockDecide(snap: MarketSnapshot, ctx: PromptContext): MockDecideOutput {
  const { ema, ticker24h } = snap;
  const change24h = parseFloat(ticker24h.priceChangePercent);

  let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let confidence = 50;
  let reason = 'EMA flat, no clear edge';

  if (ctx.hasOpenPosition) {
    if (ema.cross === 'DEATH' || ema.trend === 'DOWN') {
      action = 'SELL';
      confidence = 75;
      reason = `Trend turned DOWN (EMA fast=${ema.fast.toFixed(2)} < slow=${ema.slow.toFixed(2)}). Exit.`;
    } else if (change24h > 5) {
      action = 'SELL';
      confidence = 72;
      reason = `24h gain ${change24h}% — take profit before reversion`;
    } else {
      reason = 'Position open, trend intact, holding';
    }
  } else if (ema.cross === 'GOLDEN' && change24h > -2) {
    action = 'BUY';
    confidence = 78;
    reason = `Golden cross detected (EMA9 ${ema.fast.toFixed(2)} > EMA21 ${ema.slow.toFixed(2)}), 24h change ${change24h}%`;
  } else if (ema.trend === 'UP' && change24h > 1) {
    action = 'BUY';
    confidence = 72;
    reason = `Uptrend confirmed, EMA spread positive, 24h change ${change24h}%`;
  } else if (ema.trend === 'DOWN' && change24h < -3) {
    reason = `Downtrend with ${change24h}% drop — wait for reversal signal`;
  }

  const decision: TradeDecision = {
    action,
    confidence,
    reason,
    stopLossPercent: 2,
    takeProfitPercent: Math.max(4, ctx.minRrRatio * 2),
    timeHorizonMinutes: 720,
    keyRisks: [
      'Sudden BTC dump > 3% in 1h',
      `Loss of EMA21 support at ${ema.slow.toFixed(2)}`,
    ],
  };

  return {
    decision,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}
