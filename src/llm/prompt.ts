import { EmaState } from '../indicators/ema';
import { Kline, Ticker24hr } from '../binance/types';
import { RegimeSnapshot } from '../strategy/regime';

export interface MarketSnapshot {
  symbol: string;
  currentPrice: number;
  ticker24h: Ticker24hr;
  klines1h: Kline[];
  ema: EmaState;
  atr: number | null;
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
- Cite specific numbers in your reason: EMA values, % price change, volume, S/R levels. No vague "looks bullish" — that gets you a reject in review.
- Tighter stops in clear trends, wider stops in chop. Match takeProfit to realistic price action over your timeHorizonMinutes.
- BUY only when: trend is up (EMA fast > slow, price above both), volume confirms, and you can articulate why this entry beats waiting.
- SELL only when: clear breakdown of trend or technical target hit. Don't sell into strength without justification.

# Macro regime context

If a regime is provided, weight your decision accordingly:
- RISK_ON: BTC in uptrend, fear&greed favoring greed. Long signals get full weight; tighter trailing.
- RISK_OFF: BTC downtrend, fear dominant. Long signals require strong setup AND confluence; bias toward HOLD. Shorts/exits OK.
- CHOPPY: No clear macro direction. Smaller positions, wider stops, lower confidence overall. Default toward HOLD unless setup is textbook.
- UNKNOWN: Macro data missing — be slightly more conservative.

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

## ATR(14) on 1h
- ATR: ${snap.atr !== null ? snap.atr.toFixed(4) : 'n/a'}
- ATR as % of price: ${snap.atr !== null ? ((snap.atr / snap.currentPrice) * 100).toFixed(2) + '%' : 'n/a'}

## Last 24 hourly candles
${klineLines}

## Top of book
- Bids: ${bidsStr}
- Asks: ${asksStr}

${regimeBlock(ctx)}

Make your decision now. Remember: default HOLD, R/R >= ${ctx.minRrRatio}:1 hard floor, confidence >= ${ctx.minConfidence}% to act.`;
}
