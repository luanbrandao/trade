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
    // High conviction: a fresh golden cross is the "textbook setup" that must
    // still clear the regime-raised confidence floor in CHOPPY (base + 10).
    confidence = 82;
    reason = `Golden cross detected (EMA9 ${ema.fast.toFixed(2)} > EMA21 ${ema.slow.toFixed(2)}), 24h change ${change24h}%`;
  } else if (ema.trend === 'UP' && change24h > 1) {
    action = 'BUY';
    confidence = 72;
    reason = `Uptrend confirmed, EMA spread positive, 24h change ${change24h}%`;
  } else if (ema.trend === 'DOWN' && change24h < -3) {
    reason = `Downtrend with ${change24h}% drop — wait for reversal signal`;
  }

  // Volatility-aware bracket, mirroring what a real model is prompted to do:
  // stop ~1.5x ATR (clamped to schema bounds), target at the R/R floor.
  const atrPct = snap.atr !== null ? (snap.atr / snap.currentPrice) * 100 : null;
  const stopLossPercent = atrPct !== null ? Math.min(8, Math.max(0.8, atrPct * 1.5)) : 2;
  const takeProfitPercent = Math.min(20, Math.max(stopLossPercent * ctx.minRrRatio, 1));

  const decision: TradeDecision = {
    action,
    confidence,
    reason,
    stopLossPercent,
    takeProfitPercent,
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
