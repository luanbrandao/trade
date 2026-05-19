import { BinancePublicClient, KlineInterval } from '../binance/public-client';
import { emaState } from '../indicators/ema';
import { MarketSnapshot } from '../llm/prompt';

export interface FetchOptions {
  klineInterval: KlineInterval;
  klineLimit: number;
  bookDepth: number;
  emaFast: number;
  emaSlow: number;
}

export const DEFAULT_FETCH: FetchOptions = {
  klineInterval: '1h',
  klineLimit: 100,
  bookDepth: 10,
  emaFast: 9,
  emaSlow: 21,
};

export async function fetchSnapshot(
  pub: BinancePublicClient,
  symbol: string,
  opts: FetchOptions = DEFAULT_FETCH,
): Promise<MarketSnapshot> {
  const [ticker, klines, book] = await Promise.all([
    pub.get24hrStats(symbol),
    pub.getKlines(symbol, opts.klineInterval, opts.klineLimit),
    pub.getOrderBook(symbol, opts.bookDepth),
  ]);

  const closes = klines.map((k) => k.close);
  const ema = emaState(closes, opts.emaFast, opts.emaSlow);
  if (!ema) {
    throw new Error(`Insufficient klines for EMA on ${symbol}: got ${closes.length}, need ${opts.emaSlow + 1}`);
  }

  return {
    symbol,
    currentPrice: closes[closes.length - 1],
    ticker24h: ticker,
    klines1h: klines,
    ema,
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
