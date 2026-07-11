import { EmaState } from '../indicators/ema';
import { SupportResistance } from '../indicators/levels';
import { Kline, Ticker24hr } from '../binance/types';
import { RegimeSnapshot } from '../strategy/regime';
import { PerformanceSummary } from '../stats/performance-summary';

export interface TimeframeSummary {
  interval: string;
  trend: 'UP' | 'DOWN' | 'FLAT';
  emaFast: number;
  emaSlow: number;
  rsi: number | null;
}

export interface MarketSnapshot {
  symbol: string;
  currentPrice: number;
  ticker24h: Ticker24hr;
  klines1h: Kline[];
  ema: EmaState;
  atr: number | null;
  rsi14: number | null;
  relVolume: number | null;
  levels: SupportResistance | null;
  higherTimeframes: TimeframeSummary[];
  topBids: [string, string][];
  topAsks: [string, string][];
}

export interface PromptContext {
  minConfidence: number;
  minRrRatio: number;
  cooldownMinutes: number;
  amountUsd: number;
  hasOpenPosition: boolean;
  regime?: RegimeSnapshot;
  performance?: PerformanceSummary | null;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  return `You are a disciplined crypto spot-trading analyst for the Binance exchange. Your job is to issue one structured trading decision per request, via the decide_trade tool.

# Hard constraints (non-negotiable)

- Quote currency: USDT. Spot only. No leverage, no futures.
- Trade size: $${ctx.amountUsd} per decision.
- Minimum confidence to act: ${ctx.minConfidence}%. Below this, output HOLD.
- Minimum reward/risk ratio: ${ctx.minRrRatio}:1 (takeProfitPercent / stopLossPercent). If your stop and target don't satisfy this, output HOLD.
- Cooldown: ${ctx.cooldownMinutes} minutes between trades on the same symbol. You will not be invoked during cooldown — assume the system enforces this.
- If hasOpenPosition is true, you may emit SELL to close or HOLD to wait. Do not emit BUY.

# Decision discipline

- Default to HOLD. Acting on weak signal loses money in expectation.
- Cite specific numbers in your reason: EMA values, RSI, % price change, relative volume, the S/R levels provided. No vague "looks bullish" — that gets you a reject in review.
- Anchor stops and targets to the provided support/resistance levels: stop below the nearest support (for longs), target below the nearest resistance. A stop tighter than 1x ATR sits inside noise and will be widened or rejected by the executor.
- Respect the higher timeframes: a 1h long against a 4h/1d downtrend needs exceptional justification. Trend alignment across timeframes is your strongest edge.
- Volume confirms: breakouts on relative volume < 1.0 usually fail. Prefer entries with relative volume > 1.2.
- BUY only when: trend is up (EMA fast > slow, price above both), higher timeframes agree or are neutral, volume confirms, and you can articulate why this entry beats waiting.
- SELL only when: clear breakdown of trend or technical target hit. Don't sell into strength without justification.

# Macro regime context

If a regime is provided, weight your decision accordingly:
- RISK_ON: BTC in uptrend, fear&greed favoring greed. Long signals get full weight; tighter trailing.
- RISK_OFF: BTC downtrend, fear dominant. Long signals require strong setup AND confluence; bias toward HOLD. Shorts/exits OK.
- CHOPPY: No clear macro direction. Smaller positions, wider stops, lower confidence overall. Default toward HOLD unless setup is textbook.
- UNKNOWN: Macro data missing — be slightly more conservative.

# Recent performance feedback

If a recent-performance block is provided, treat it as ground truth about how your recent decisions resolved. If stops are being hit before targets on trades that would have worked (stopped-then-reached-TP count is high), widen your stops. If a confidence bucket shows poor win rate, demand more confluence before assigning that confidence.

# Output rules

- Call decide_trade exactly once. No text response, no other tool calls.
- All fields required. No partial decisions.
- keyRisks: name the specific levels/events that would invalidate the thesis (e.g. "loss of 67500 EMA21 support", "BTC dump > 2% in 1h").

You operate inside an automated trading system. Your decisions execute real orders. Be precise. Be skeptical. When in doubt: HOLD.`;
}

function regimeBlock(ctx: PromptContext): string {
  if (!ctx.regime) return '## Macro regime\n- not provided';
  const r = ctx.regime;
  const fg =
    r.fearGreedIndex !== null ? `${r.fearGreedIndex} (${r.fearGreedLabel ?? 'n/a'})` : 'n/a';
  return `## Macro regime
- Regime: ${r.regime}
- BTC trend: ${r.btcTrend}  (EMA50 slope ${r.btcEma50Slope.toFixed(2)}%/5d, 30d change ${r.btcChange30dPct.toFixed(2)}%)
- Fear & Greed: ${fg}
- Source: ${r.source}`;
}

function levelsBlock(snap: MarketSnapshot): string {
  if (!snap.levels) return '## Support / Resistance\n- insufficient data';
  const l = snap.levels;
  const fmt = (arr: number[]) => (arr.length > 0 ? arr.map((v) => v.toFixed(4)).join(' | ') : 'none detected');
  return `## Support / Resistance (swing pivots on 1h)
- Supports below price (closest first): ${fmt(l.supports)}
- Resistances above price (closest first): ${fmt(l.resistances)}
- Period high: ${l.periodHigh.toFixed(4)}   Period low: ${l.periodLow.toFixed(4)}`;
}

function higherTimeframesBlock(snap: MarketSnapshot): string {
  if (snap.higherTimeframes.length === 0) return '## Higher timeframes\n- not available';
  const lines = snap.higherTimeframes.map(
    (tf) =>
      `- ${tf.interval}: trend ${tf.trend}  (EMA fast ${tf.emaFast.toFixed(4)} / slow ${tf.emaSlow.toFixed(4)})  RSI ${tf.rsi !== null ? tf.rsi.toFixed(1) : 'n/a'}`,
  );
  return `## Higher timeframes\n${lines.join('\n')}`;
}

function performanceBlock(ctx: PromptContext): string {
  const p = ctx.performance;
  if (!p) return '';
  const bySymbol = p.bySymbol
    .map((s) => `  - ${s.symbol}: ${s.trades} trades, WR ${(s.winRate * 100).toFixed(0)}%, avg ${s.avgPnlPct.toFixed(2)}%`)
    .join('\n');
  const byConf = p.byConfidence
    .map((b) => `  - confidence ${b.range}: ${b.trades} trades, WR ${(b.winRate * 100).toFixed(0)}%`)
    .join('\n');
  return `
## Recent performance (your last ${p.totalClosed} closed trades)
- Win rate: ${(p.winRate * 100).toFixed(0)}%   Avg PnL: ${p.avgPnlPct.toFixed(2)}%
- Stopped out then price reached TP anyway: ${p.slStoppedBeforeTpCount}/${p.slCount} SL trades${p.slStoppedBeforeTpCount > 0 && p.slCount > 0 && p.slStoppedBeforeTpCount / p.slCount >= 0.3 ? '  ⚠ stops likely too tight — widen' : ''}
- By symbol:
${bySymbol}${byConf ? `\n- By confidence bucket:\n${byConf}` : ''}
`;
}

export function buildUserPrompt(snap: MarketSnapshot, ctx: PromptContext): string {
  const t = snap.ticker24h;
  const klineLines = snap.klines1h
    .slice(-24)
    .map((k) => {
      const ts = new Date(k.openTime).toISOString().slice(0, 16).replace('T', ' ');
      return `  ${ts}  O=${k.open}  H=${k.high}  L=${k.low}  C=${k.close}  V=${k.volume.toFixed(2)}`;
    })
    .join('\n');

  const bidsStr = snap.topBids
    .slice(0, 5)
    .map(([p, q]) => `${p} @ ${q}`)
    .join(' | ');
  const asksStr = snap.topAsks
    .slice(0, 5)
    .map(([p, q]) => `${p} @ ${q}`)
    .join(' | ');

  return `# Market snapshot — ${snap.symbol}

Current price: ${snap.currentPrice}
Has open position: ${ctx.hasOpenPosition ? 'YES (BUY blocked)' : 'NO'}

## 24h ticker
- Last: ${t.lastPrice}  Open: ${t.openPrice}  High: ${t.highPrice}  Low: ${t.lowPrice}
- Change: ${t.priceChange} (${t.priceChangePercent}%)
- Volume (base): ${t.volume}   Quote: ${t.quoteVolume}
- Trades: ${t.count}

## EMA(9/21) on 1h closes
- EMA fast: ${snap.ema.fast.toFixed(4)}
- EMA slow: ${snap.ema.slow.toFixed(4)}
- Cross signal: ${snap.ema.cross}
- Trend: ${snap.ema.trend}

## Momentum / volume (1h)
- RSI(14): ${snap.rsi14 !== null ? snap.rsi14.toFixed(1) : 'n/a'}
- Relative volume (last candle vs 20-candle avg): ${snap.relVolume !== null ? snap.relVolume.toFixed(2) + 'x' : 'n/a'}

## ATR(14) on 1h
- ATR: ${snap.atr !== null ? snap.atr.toFixed(4) : 'n/a'}
- ATR as % of price: ${snap.atr !== null ? ((snap.atr / snap.currentPrice) * 100).toFixed(2) + '%' : 'n/a'}

${levelsBlock(snap)}

${higherTimeframesBlock(snap)}

## Last 24 hourly candles
${klineLines}

## Top of book
- Bids: ${bidsStr}
- Asks: ${asksStr}

${regimeBlock(ctx)}
${performanceBlock(ctx)}
Make your decision now. Remember: default HOLD, R/R >= ${ctx.minRrRatio}:1 hard floor, confidence >= ${ctx.minConfidence}% to act.`;
}
