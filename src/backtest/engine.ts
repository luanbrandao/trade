import { BinancePublicClient, KlineInterval } from '../binance/public-client';
import { Kline, Ticker24hr } from '../binance/types';
import { emaState } from '../indicators/ema';
import { atr } from '../indicators/atr';
import { rsi } from '../indicators/rsi';
import { supportResistance, relativeVolume } from '../indicators/levels';
import { MarketSnapshot, PromptContext, TimeframeSummary } from '../llm/prompt';
import { TradeDecision } from '../llm/schema';
import { ClaudeClient } from '../llm/claude-client';
import { mockDecide } from './mock-llm';
import { classifyRegime, fetchFearGreedHistory, RegimeSnapshot } from '../strategy/regime';
import { effectiveMinConfidence } from '../strategy/regime-policy';
import { summarizeTimeframe } from '../strategy/market-data';
import { log } from '../logger';

export type LlmMode = 'mock' | 'claude';

export interface BacktestOptions {
  symbol: string;
  interval: KlineInterval;
  from: Date;
  to: Date;
  llmMode: LlmMode;
  emaFast: number;
  emaSlow: number;
  amountUsd: number;
  minConfidence: number;
  minRrRatio: number;
  cooldownMinutes: number;
  warmupCandles: number;
  slippagePct: number;
  /** Exchange fee % per side (Binance spot taker = 0.1). Applied on entry and exit notional. */
  feePct: number;
  /** Re-evaluate open positions with the LLM each candle, allowing early SELL exits (mirrors live). */
  managePositions?: boolean;
}

export interface SimulatedTrade {
  entryTs: number;
  exitTs: number;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  tpPrice: number;
  slPrice: number;
  qty: number;
  pnlQuote: number;
  pnlPct: number;
  outcome: 'TP' | 'SL' | 'TIMEOUT' | 'EARLY_EXIT';
  decisionConfidence: number;
  holdMinutes: number;
  regime?: string;
}

export interface BacktestResult {
  symbol: string;
  trades: SimulatedTrade[];
  totalCandles: number;
  decisionsTotal: number;
  decisionsExecuted: number;
  totalLlmCostUsd: number;
  totalFeesQuote: number;
}

const BINANCE_KLINE_LIMIT = 1000;

export async function downloadKlines(
  pub: BinancePublicClient,
  symbol: string,
  interval: KlineInterval,
  from: Date,
  to: Date,
): Promise<Kline[]> {
  const all: Kline[] = [];
  let cursor = from.getTime();
  const endMs = to.getTime();

  while (cursor < endMs) {
    const batch = await pub.getKlines(symbol, interval, BINANCE_KLINE_LIMIT, cursor, endMs);
    if (batch.length === 0) break;
    all.push(...batch);
    const lastClose = batch[batch.length - 1].closeTime;
    if (lastClose <= cursor) break;
    cursor = lastClose + 1;
    if (batch.length < BINANCE_KLINE_LIMIT) break;
  }

  return all;
}

function intervalToMs(interval: KlineInterval): number {
  const map: Record<string, number> = {
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h': 3_600_000,
    '2h': 7_200_000,
    '4h': 14_400_000,
    '6h': 21_600_000,
    '8h': 28_800_000,
    '12h': 43_200_000,
    '1d': 86_400_000,
  };
  return map[interval] ?? 3_600_000;
}

function syntheticTicker(symbol: string, window24: Kline[]): Ticker24hr {
  const first = window24[0];
  const last = window24[window24.length - 1];
  const high = Math.max(...window24.map((k) => k.high));
  const low = Math.min(...window24.map((k) => k.low));
  const volume = window24.reduce((s, k) => s + k.volume, 0);
  const change = last.close - first.open;
  const pct = (change / first.open) * 100;

  return {
    symbol,
    priceChange: change.toFixed(2),
    priceChangePercent: pct.toFixed(2),
    weightedAvgPrice: ((first.open + last.close) / 2).toFixed(2),
    lastPrice: last.close.toFixed(2),
    volume: volume.toFixed(4),
    quoteVolume: (volume * last.close).toFixed(2),
    openPrice: first.open.toFixed(2),
    highPrice: high.toFixed(2),
    lowPrice: low.toFixed(2),
    openTime: first.openTime,
    closeTime: last.closeTime,
    count: window24.reduce((s, k) => s + k.trades, 0),
  };
}

/** Aggregate klines into a coarser bucket (e.g. 1h → 4h). Last bucket may be partial. */
export function resampleKlines(klines: Kline[], bucketMs: number): Kline[] {
  const out: Kline[] = [];
  let bucket: Kline | null = null;
  let bucketStart = -1;

  for (const k of klines) {
    const start = Math.floor(k.openTime / bucketMs) * bucketMs;
    if (start !== bucketStart) {
      if (bucket) out.push(bucket);
      bucketStart = start;
      bucket = { ...k, openTime: start, closeTime: start + bucketMs - 1 };
    } else if (bucket) {
      bucket.high = Math.max(bucket.high, k.high);
      bucket.low = Math.min(bucket.low, k.low);
      bucket.close = k.close;
      bucket.volume += k.volume;
      bucket.trades += k.trades;
      bucket.closeTime = start + bucketMs - 1;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

function utcDayStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Point-in-time regime lookup: classifies from the BTC daily candles closed
 * before `ts` plus that day's fear&greed reading. Memoized per UTC day.
 */
export function makeRegimeLookup(
  btcDaily: Kline[],
  fgHistory: Map<number, number>,
): (ts: number) => RegimeSnapshot | undefined {
  const memo = new Map<number, RegimeSnapshot | undefined>();
  return (ts: number) => {
    const day = utcDayStart(ts);
    if (memo.has(day)) return memo.get(day);

    const closes = btcDaily.filter((k) => k.closeTime <= ts).map((k) => k.close);
    let snap: RegimeSnapshot | undefined;
    if (closes.length >= 50) {
      const fg = fgHistory.get(day) ?? null;
      snap = classifyRegime(closes.slice(-60), fg);
      snap.source = fg !== null ? 'backtest replay (binance+fng)' : 'backtest replay (binance only)';
    }
    memo.set(day, snap);
    return snap;
  };
}

interface FillOutcome {
  exitIdx: number;
  exitPrice: number;
  outcome: 'TP' | 'SL' | 'TIMEOUT' | 'EARLY_EXIT';
}

export async function runBacktest(opts: BacktestOptions): Promise<BacktestResult> {
  const pub = new BinancePublicClient();

  log.info('Downloading klines', {
    symbol: opts.symbol,
    interval: opts.interval,
    from: opts.from.toISOString().slice(0, 10),
    to: opts.to.toISOString().slice(0, 10),
  });

  const klines = await downloadKlines(pub, opts.symbol, opts.interval, opts.from, opts.to);
  log.info('Klines loaded', { count: klines.length });

  if (klines.length < opts.warmupCandles + 10) {
    throw new Error(`Insufficient klines (${klines.length}) for warmup ${opts.warmupCandles}`);
  }

  // Point-in-time regime data: BTC dailies (with 90d lead for EMA50 warmup) + fear&greed history.
  let regimeAt: (ts: number) => RegimeSnapshot | undefined = () => undefined;
  try {
    const regimeFrom = new Date(opts.from.getTime() - 90 * 86_400_000);
    const [btcDaily, fgHistory] = await Promise.all([
      downloadKlines(pub, 'BTCUSDT', '1d', regimeFrom, opts.to),
      fetchFearGreedHistory(),
    ]);
    regimeAt = makeRegimeLookup(btcDaily, fgHistory);
    log.info('Regime data loaded', { btcDailyCandles: btcDaily.length, fngDays: fgHistory.size });
  } catch (err: any) {
    log.warn('Regime data unavailable — backtest runs without macro context', { err: err.message });
  }

  const claude = opts.llmMode === 'claude' ? new ClaudeClient() : null;
  const intervalMs = intervalToMs(opts.interval);
  const cooldownMs = opts.cooldownMinutes * 60_000;
  const feeFrac = opts.feePct / 100;
  const exitSlipFrac = opts.slippagePct / 100;

  const trades: SimulatedTrade[] = [];
  let lastTradeTs = 0;
  let decisionsTotal = 0;
  let decisionsExecuted = 0;
  let totalLlmCostUsd = 0;
  let totalFeesQuote = 0;
  let openTradeExitIdx = -1;

  const buildSnapshot = (i: number): MarketSnapshot | null => {
    const candle = klines[i];
    const window = klines.slice(Math.max(0, i - opts.emaSlow * 3), i + 1);
    const closes = window.map((k) => k.close);
    const ema = emaState(closes, opts.emaFast, opts.emaSlow);
    if (!ema) return null;

    const window24 = klines.slice(Math.max(0, i - 23), i + 1);
    const historyToNow = klines.slice(0, i + 1);

    const higherTimeframes: TimeframeSummary[] = [];
    if (intervalMs < 14_400_000) {
      const k4h = resampleKlines(historyToNow, 14_400_000);
      const tf4h = summarizeTimeframe('4h', k4h, opts.emaFast, opts.emaSlow);
      if (tf4h) higherTimeframes.push(tf4h);
    }
    if (intervalMs < 86_400_000) {
      const k1d = resampleKlines(historyToNow, 86_400_000);
      const tf1d = summarizeTimeframe('1d', k1d, opts.emaFast, opts.emaSlow);
      if (tf1d) higherTimeframes.push(tf1d);
    }

    return {
      symbol: opts.symbol,
      currentPrice: candle.close,
      ticker24h: syntheticTicker(opts.symbol, window24),
      klines1h: window24,
      ema,
      atr: atr(window, 14),
      rsi14: rsi(closes, 14),
      relVolume: relativeVolume(window, 20),
      levels: supportResistance(window, candle.close),
      higherTimeframes,
      topBids: [[candle.close.toString(), '1']],
      topAsks: [[candle.close.toString(), '1']],
    };
  };

  const decide = async (
    snapshot: MarketSnapshot,
    ctx: PromptContext,
  ): Promise<TradeDecision | null> => {
    if (claude) {
      try {
        const r = await claude.decide(snapshot, ctx);
        totalLlmCostUsd += r.usage.costUsd;
        return r.decision;
      } catch (err: any) {
        log.warn('Claude failed mid-backtest', { err: err.message });
        return null;
      }
    }
    return mockDecide(snapshot, ctx).decision;
  };

  const simulateTrade = async (
    entryIdx: number,
    entryPrice: number,
    tpPercent: number,
    slPercent: number,
    timeHorizonMs: number,
  ): Promise<FillOutcome> => {
    const tpPrice = entryPrice * (1 + tpPercent / 100);
    const slPrice = entryPrice * (1 - slPercent / 100);
    const deadlineTs = klines[entryIdx].openTime + timeHorizonMs;

    for (let i = entryIdx + 1; i < klines.length; i++) {
      const k = klines[i];
      if (k.openTime > deadlineTs) {
        return { exitIdx: i, exitPrice: k.open * (1 - exitSlipFrac), outcome: 'TIMEOUT' };
      }
      // Bracket lives on the exchange and fires intrabar — check before any
      // end-of-candle management decision. SL first: conservative on candles
      // that touch both levels.
      if (k.low <= slPrice) {
        return { exitIdx: i, exitPrice: slPrice * (1 - exitSlipFrac), outcome: 'SL' };
      }
      if (k.high >= tpPrice) {
        return { exitIdx: i, exitPrice: tpPrice * (1 - exitSlipFrac), outcome: 'TP' };
      }

      if (opts.managePositions) {
        const snap = buildSnapshot(i);
        if (snap) {
          // Exits use the base floor, not the regime-raised one: a hostile
          // regime should make it harder to enter, never harder to get out.
          const ctx: PromptContext = {
            minConfidence: opts.minConfidence,
            minRrRatio: opts.minRrRatio,
            cooldownMinutes: opts.cooldownMinutes,
            amountUsd: opts.amountUsd,
            hasOpenPosition: true,
            regime: regimeAt(k.openTime),
          };
          decisionsTotal += 1;
          const d = await decide(snap, ctx);
          if (d && d.action === 'SELL' && d.confidence >= opts.minConfidence) {
            const exitIdx = Math.min(i + 1, klines.length - 1);
            const rawExit = exitIdx > i ? klines[exitIdx].open : klines[i].close;
            return { exitIdx, exitPrice: rawExit * (1 - exitSlipFrac), outcome: 'EARLY_EXIT' };
          }
        }
      }
    }

    const lastIdx = klines.length - 1;
    return { exitIdx: lastIdx, exitPrice: klines[lastIdx].close * (1 - exitSlipFrac), outcome: 'TIMEOUT' };
  };

  for (let i = opts.warmupCandles; i < klines.length - 1; i++) {
    const candle = klines[i];

    if (i <= openTradeExitIdx) continue;
    if (candle.closeTime - lastTradeTs < cooldownMs && lastTradeTs > 0) continue;

    const snapshot = buildSnapshot(i);
    if (!snapshot) continue;

    if (snapshot.ema.trend !== 'UP' && snapshot.ema.cross !== 'GOLDEN') continue;

    const regime = regimeAt(candle.openTime);
    const confidenceFloor = effectiveMinConfidence(opts.minConfidence, regime?.regime);

    const ctx: PromptContext = {
      minConfidence: confidenceFloor,
      minRrRatio: opts.minRrRatio,
      cooldownMinutes: opts.cooldownMinutes,
      amountUsd: opts.amountUsd,
      hasOpenPosition: false,
      regime,
    };

    decisionsTotal += 1;
    const decision = await decide(snapshot, ctx);
    if (!decision) continue;

    if (decision.action !== 'BUY') continue;
    if (decision.confidence < confidenceFloor) continue;
    const rr = decision.takeProfitPercent / decision.stopLossPercent;
    if (rr < opts.minRrRatio) continue;

    const entryIdx = i + 1;
    const rawEntry = klines[entryIdx].open;
    const entryPrice = rawEntry * (1 + opts.slippagePct / 100);
    const qty = opts.amountUsd / entryPrice;
    const timeHorizonMs = decision.timeHorizonMinutes * 60_000;

    const fill = await simulateTrade(
      entryIdx,
      entryPrice,
      decision.takeProfitPercent,
      decision.stopLossPercent,
      timeHorizonMs,
    );

    const fees = (entryPrice + fill.exitPrice) * qty * feeFrac;
    totalFeesQuote += fees;
    const pnlQuote = (fill.exitPrice - entryPrice) * qty - fees;
    const pnlPct = (pnlQuote / (entryPrice * qty)) * 100;
    const tpPrice = entryPrice * (1 + decision.takeProfitPercent / 100);
    const slPrice = entryPrice * (1 - decision.stopLossPercent / 100);

    trades.push({
      entryTs: klines[entryIdx].openTime,
      exitTs: klines[fill.exitIdx].openTime,
      side: 'BUY',
      entryPrice,
      exitPrice: fill.exitPrice,
      tpPrice,
      slPrice,
      qty,
      pnlQuote,
      pnlPct,
      outcome: fill.outcome,
      decisionConfidence: decision.confidence,
      holdMinutes: (klines[fill.exitIdx].openTime - klines[entryIdx].openTime) / 60_000,
      regime: regime?.regime,
    });

    decisionsExecuted += 1;
    lastTradeTs = klines[fill.exitIdx].closeTime;
    openTradeExitIdx = fill.exitIdx;
  }

  return {
    symbol: opts.symbol,
    trades,
    totalCandles: klines.length,
    decisionsTotal,
    decisionsExecuted,
    totalLlmCostUsd,
    totalFeesQuote,
  };
}
