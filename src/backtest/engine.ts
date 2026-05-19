import { BinancePublicClient, KlineInterval } from '../binance/public-client';
import { Kline, Ticker24hr } from '../binance/types';
import { emaState } from '../indicators/ema';
import { MarketSnapshot, PromptContext } from '../llm/prompt';
import { TradeDecision } from '../llm/schema';
import { ClaudeClient } from '../llm/claude-client';
import { mockDecide } from './mock-llm';
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
  outcome: 'TP' | 'SL' | 'TIMEOUT';
  decisionConfidence: number;
  holdMinutes: number;
}

export interface BacktestResult {
  symbol: string;
  trades: SimulatedTrade[];
  totalCandles: number;
  decisionsTotal: number;
  decisionsExecuted: number;
  totalLlmCostUsd: number;
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

function simulateFill(
  klines: Kline[],
  entryIdx: number,
  entryPrice: number,
  side: 'BUY' | 'SELL',
  tpPercent: number,
  slPercent: number,
  timeHorizonMs: number,
): { exitIdx: number; exitPrice: number; outcome: 'TP' | 'SL' | 'TIMEOUT' } {
  const isLong = side === 'BUY';
  const tpPrice = entryPrice * (1 + (isLong ? tpPercent : -tpPercent) / 100);
  const slPrice = entryPrice * (1 + (isLong ? -slPercent : slPercent) / 100);
  const entryTs = klines[entryIdx].openTime;
  const deadlineTs = entryTs + timeHorizonMs;

  for (let i = entryIdx + 1; i < klines.length; i++) {
    const k = klines[i];
    if (k.openTime > deadlineTs) {
      return { exitIdx: i, exitPrice: k.open, outcome: 'TIMEOUT' };
    }
    if (isLong) {
      if (k.low <= slPrice) return { exitIdx: i, exitPrice: slPrice, outcome: 'SL' };
      if (k.high >= tpPrice) return { exitIdx: i, exitPrice: tpPrice, outcome: 'TP' };
    } else {
      if (k.high >= slPrice) return { exitIdx: i, exitPrice: slPrice, outcome: 'SL' };
      if (k.low <= tpPrice) return { exitIdx: i, exitPrice: tpPrice, outcome: 'TP' };
    }
  }

  const last = klines[klines.length - 1];
  return { exitIdx: klines.length - 1, exitPrice: last.close, outcome: 'TIMEOUT' };
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

  const claude = opts.llmMode === 'claude' ? new ClaudeClient() : null;
  const intervalMs = intervalToMs(opts.interval);
  const cooldownMs = opts.cooldownMinutes * 60_000;

  const trades: SimulatedTrade[] = [];
  let lastTradeTs = 0;
  let decisionsTotal = 0;
  let decisionsExecuted = 0;
  let totalLlmCostUsd = 0;
  let openTradeExitIdx = -1;

  for (let i = opts.warmupCandles; i < klines.length - 1; i++) {
    const candle = klines[i];

    if (i <= openTradeExitIdx) continue;
    if (candle.closeTime - lastTradeTs < cooldownMs && lastTradeTs > 0) continue;

    const window = klines.slice(Math.max(0, i - opts.emaSlow * 3), i + 1);
    const closes = window.map((k) => k.close);
    const ema = emaState(closes, opts.emaFast, opts.emaSlow);
    if (!ema) continue;

    if (ema.trend !== 'UP' && ema.cross !== 'GOLDEN') continue;

    const window24 = klines.slice(Math.max(0, i - 23), i + 1);
    const snapshot: MarketSnapshot = {
      symbol: opts.symbol,
      currentPrice: candle.close,
      ticker24h: syntheticTicker(opts.symbol, window24),
      klines1h: window24,
      ema,
      topBids: [[candle.close.toString(), '1']],
      topAsks: [[candle.close.toString(), '1']],
    };

    const ctx: PromptContext = {
      minConfidence: opts.minConfidence,
      minRrRatio: opts.minRrRatio,
      cooldownMinutes: opts.cooldownMinutes,
      amountUsd: opts.amountUsd,
      hasOpenPosition: false,
    };

    decisionsTotal += 1;
    let decision: TradeDecision;

    if (claude) {
      try {
        const r = await claude.decide(snapshot, ctx);
        decision = r.decision;
        totalLlmCostUsd += r.usage.costUsd;
      } catch (err: any) {
        log.warn('Claude failed mid-backtest', { i, err: err.message });
        continue;
      }
    } else {
      decision = mockDecide(snapshot, ctx).decision;
    }

    if (decision.action !== 'BUY') continue;
    if (decision.confidence < opts.minConfidence) continue;
    const rr = decision.takeProfitPercent / decision.stopLossPercent;
    if (rr < opts.minRrRatio) continue;

    const entryIdx = i + 1;
    const entryPrice = klines[entryIdx].open;
    const qty = opts.amountUsd / entryPrice;
    const timeHorizonMs = decision.timeHorizonMinutes * 60_000;

    const fill = simulateFill(
      klines,
      entryIdx,
      entryPrice,
      'BUY',
      decision.takeProfitPercent,
      decision.stopLossPercent,
      timeHorizonMs,
    );

    const pnlQuote = (fill.exitPrice - entryPrice) * qty;
    const pnlPct = ((fill.exitPrice - entryPrice) / entryPrice) * 100;
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
  };
}
