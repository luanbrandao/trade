import { config } from '../config/config';
import { getDb } from '../storage/db';
import { BinancePublicClient } from '../binance/public-client';
import { checkDailyGate } from '../paper/daily-gate';

export interface ClosedTrade {
  id: number;
  ts: number;
  closed_ts: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  avg_price: number;
  closed_price: number;
  qty: number;
  quote_qty: number;
  pnl_quote: number;
  pnl_pct: number;
  status: string;
  strategy_name: string;
  tp_pct: number | null;
  sl_pct: number | null;
}

export interface OpenTrade {
  id: number;
  ts: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  avg_price: number;
  qty: number;
  strategy_name: string;
}

export interface Stats {
  strategyName: string;
  windowStart: number;
  windowEnd: number;
  startingEquity: number;
  closed: ClosedTrade[];
  open: OpenTrade[];
  openPnlQuote: number;
  realizedPnlQuote: number;
  realizedPnlPct: number;
  equityNow: number;
  winRateTotal: number;
  winRateBuy: number;
  winRateSell: number;
  winsBuy: number;
  totalBuy: number;
  winsSell: number;
  totalSell: number;
  maxDdPct: number;
  bestTrade: ClosedTrade | null;
  worstTrade: ClosedTrade | null;
  avgHoldingMinutes: number;
  avgRrRatio: number;
  dailyGateReason: string | null;
  dailyGateDdPct: number;
  dailyGateStreak: number;
  equityCurve: { ts: number; equity: number }[];
}

export function collectStats(strategy: string | undefined, since: number | undefined): Stats {
  const db = getDb();
  const strategyName = strategy ?? config.trading.strategyName;
  const startingEquity = config.trading.accountEquityUsd;

  const baseSince = since ?? 0;

  const closed = db
    .prepare(
      `SELECT t.id, t.ts, t.closed_ts, t.symbol, t.side, t.avg_price, t.closed_price,
              t.qty, t.quote_qty, t.pnl_quote, t.pnl_pct, t.status, t.strategy_name,
              d.take_profit_pct AS tp_pct, d.stop_loss_pct AS sl_pct
       FROM trades t
       LEFT JOIN decisions d ON d.id = t.decision_id
       WHERE t.mode = 'dryrun'
         AND t.strategy_name = ?
         AND t.status IN ('TP_FILLED','SL_FILLED','CANCELED')
         AND t.closed_ts >= ?
       ORDER BY t.closed_ts ASC`,
    )
    .all(strategyName, baseSince) as ClosedTrade[];

  const openRows = db
    .prepare(
      `SELECT id, ts, symbol, side, avg_price, qty, strategy_name
       FROM trades
       WHERE mode = 'dryrun' AND strategy_name = ? AND status = 'OPEN'`,
    )
    .all(strategyName) as OpenTrade[];

  const realizedPnlQuote = closed.reduce((s, t) => s + (t.pnl_quote ?? 0), 0);
  const realizedPnlPct = (realizedPnlQuote / startingEquity) * 100;

  const buyClosed = closed.filter((t) => t.side === 'BUY');
  const sellClosed = closed.filter((t) => t.side === 'SELL');
  const winsBuy = buyClosed.filter((t) => t.pnl_quote > 0).length;
  const winsSell = sellClosed.filter((t) => t.pnl_quote > 0).length;
  const winsTotal = winsBuy + winsSell;
  const winRateTotal = closed.length > 0 ? winsTotal / closed.length : 0;
  const winRateBuy = buyClosed.length > 0 ? winsBuy / buyClosed.length : 0;
  const winRateSell = sellClosed.length > 0 ? winsSell / sellClosed.length : 0;

  let peak = startingEquity;
  let maxDdPct = 0;
  const equityCurve: { ts: number; equity: number }[] = [
    { ts: closed[0]?.ts ?? Date.now(), equity: startingEquity },
  ];
  let runningEquity = startingEquity;
  for (const t of closed) {
    runningEquity += t.pnl_quote;
    if (runningEquity > peak) peak = runningEquity;
    const dd = ((peak - runningEquity) / peak) * 100;
    if (dd > maxDdPct) maxDdPct = dd;
    equityCurve.push({ ts: t.closed_ts, equity: runningEquity });
  }

  const bestTrade = closed.reduce<ClosedTrade | null>(
    (b, t) => (b === null || t.pnl_quote > b.pnl_quote ? t : b),
    null,
  );
  const worstTrade = closed.reduce<ClosedTrade | null>(
    (w, t) => (w === null || t.pnl_quote < w.pnl_quote ? t : w),
    null,
  );
  const avgHoldingMinutes =
    closed.length > 0
      ? closed.reduce((s, t) => s + (t.closed_ts - t.ts) / 60_000, 0) / closed.length
      : 0;
  const avgRrRatio =
    closed.length > 0
      ? closed.reduce((s, t) => (t.tp_pct && t.sl_pct ? s + t.tp_pct / t.sl_pct : s), 0) /
        closed.length
      : 0;

  const gate = checkDailyGate();

  return {
    strategyName,
    windowStart: closed[0]?.ts ?? Date.now(),
    windowEnd: Date.now(),
    startingEquity,
    closed,
    open: openRows,
    openPnlQuote: 0,
    realizedPnlQuote,
    realizedPnlPct,
    equityNow: startingEquity + realizedPnlQuote,
    winRateTotal,
    winRateBuy,
    winRateSell,
    winsBuy,
    totalBuy: buyClosed.length,
    winsSell,
    totalSell: sellClosed.length,
    maxDdPct,
    bestTrade,
    worstTrade,
    avgHoldingMinutes,
    avgRrRatio,
    dailyGateReason: gate.allowed ? null : gate.reason ?? null,
    dailyGateDdPct: gate.ddPct,
    dailyGateStreak: gate.streak,
    equityCurve,
  };
}

export async function addOpenPnl(stats: Stats): Promise<Stats> {
  if (stats.open.length === 0) return stats;
  const pub = new BinancePublicClient();
  const symbols = Array.from(new Set(stats.open.map((t) => t.symbol)));
  const prices: Record<string, number> = {};
  for (const sym of symbols) {
    try {
      prices[sym] = parseFloat((await pub.getPrice(sym)).price);
    } catch {
      prices[sym] = 0;
    }
  }
  let openPnl = 0;
  for (const t of stats.open) {
    const price = prices[t.symbol] ?? t.avg_price;
    const pnl = (t.side === 'BUY' ? price - t.avg_price : t.avg_price - price) * t.qty;
    openPnl += pnl;
  }
  return { ...stats, openPnlQuote: openPnl };
}
