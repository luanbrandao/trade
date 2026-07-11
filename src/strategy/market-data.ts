import { BinancePublicClient, KlineInterval } from '../binance/public-client';
import { emaState } from '../indicators/ema';
import { atr } from '../indicators/atr';
import { rsi } from '../indicators/rsi';
import { supportResistance, relativeVolume } from '../indicators/levels';
import { MarketSnapshot, TimeframeSummary } from '../llm/prompt';
import { Kline } from '../binance/types';
import { config } from '../config/config';
import { log } from '../logger';

export interface FetchOptions {
  klineInterval: KlineInterval;
  klineLimit: number;
  bookDepth: number;
  emaFast: number;
  emaSlow: number;
}

export const DEFAULT_FETCH: FetchOptions = {
  klineInterval: config.trading.klineInterval,
  klineLimit: 100,
  bookDepth: 10,
  emaFast: 9,
  emaSlow: 21,
};

/** EMA trend + RSI condensed view of one timeframe, for the LLM prompt. */
export function summarizeTimeframe(
  interval: string,
  klines: Kline[],
  emaFast = 9,
  emaSlow = 21,
): TimeframeSummary | null {
  const closes = klines.map((k) => k.close);
  const ema = emaState(closes, emaFast, emaSlow);
  if (!ema) return null;
  return {
    interval,
    trend: ema.trend,
    emaFast: ema.fast,
    emaSlow: ema.slow,
    rsi: rsi(closes, 14),
  };
}

export async function fetchSnapshot(
  pub: BinancePublicClient,
  symbol: string,
  opts: FetchOptions = DEFAULT_FETCH,
): Promise<MarketSnapshot> {
  const [ticker, klines, book, klines4h, klines1d] = await Promise.all([
    pub.get24hrStats(symbol),
    pub.getKlines(symbol, opts.klineInterval, opts.klineLimit),
    pub.getOrderBook(symbol, opts.bookDepth),
    // Higher-timeframe context is advisory: degrade to empty on failure
    // instead of blocking the whole snapshot.
    pub.getKlines(symbol, '4h', 60).catch((err) => {
      log.warn('4h klines fetch failed', { symbol, err: err.message });
      return [] as Kline[];
    }),
    pub.getKlines(symbol, '1d', 60).catch((err) => {
      log.warn('1d klines fetch failed', { symbol, err: err.message });
      return [] as Kline[];
    }),
  ]);

  const closes = klines.map((k) => k.close);
  const ema = emaState(closes, opts.emaFast, opts.emaSlow);
  if (!ema) {
    throw new Error(`Insufficient klines for EMA on ${symbol}: got ${closes.length}, need ${opts.emaSlow + 1}`);
  }

  const atrValue = atr(klines, 14);
  const currentPrice = closes[closes.length - 1];

  const higherTimeframes: TimeframeSummary[] = [];
  const tf4h = summarizeTimeframe('4h', klines4h, opts.emaFast, opts.emaSlow);
  if (tf4h) higherTimeframes.push(tf4h);
  const tf1d = summarizeTimeframe('1d', klines1d, opts.emaFast, opts.emaSlow);
  if (tf1d) higherTimeframes.push(tf1d);

  return {
    symbol,
    currentPrice,
    ticker24h: ticker,
    klines1h: klines,
    ema,
    atr: atrValue,
    rsi14: rsi(closes, 14),
    relVolume: relativeVolume(klines, 20),
    levels: supportResistance(klines, currentPrice),
    higherTimeframes,
    topBids: book.bids.slice(0, 5),
    topAsks: book.asks.slice(0, 5),
  };
}

export type EmaFilterResult = 'PASS_LONG' | 'PASS_SHORT' | 'SKIP';

export function emaPreFilter(snap: MarketSnapshot, hasOpenPosition: boolean): EmaFilterResult {
  const { trend, cross } = snap.ema;

  if (hasOpenPosition) {
    return 'PASS_SHORT';
  }

  if (trend === 'UP' || cross === 'GOLDEN') return 'PASS_LONG';
  if (trend === 'DOWN' || cross === 'DEATH') return 'SKIP';
  return 'SKIP';
}
