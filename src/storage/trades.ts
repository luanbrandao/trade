import { getDb } from './db';

export type TradeStatus = 'OPEN' | 'TP_FILLED' | 'SL_FILLED' | 'CANCELED' | 'ERROR';

export interface TradeRecord {
  id?: number;
  decisionId: number | null;
  ts: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  avgPrice: number;
  quoteQty: number;
  binanceOrderId: string;
  ocoOrderListId: string | null;
  tpPrice: number | null;
  slPrice: number | null;
  status: TradeStatus;
  closedTs: number | null;
  closedPrice: number | null;
  pnlQuote: number | null;
  pnlPct: number | null;
  mode: 'dryrun' | 'live' | 'backtest';
  strategyName: string;
}

export function insertTrade(t: TradeRecord): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO trades (
      decision_id, ts, symbol, side, qty, avg_price, quote_qty,
      binance_order_id, oco_order_list_id, tp_price, sl_price,
      status, closed_ts, closed_price, pnl_quote, pnl_pct, mode, strategy_name
    ) VALUES (
      @decisionId, @ts, @symbol, @side, @qty, @avgPrice, @quoteQty,
      @binanceOrderId, @ocoOrderListId, @tpPrice, @slPrice,
      @status, @closedTs, @closedPrice, @pnlQuote, @pnlPct, @mode, @strategyName
    )
  `);
  const result = stmt.run(t);
  return Number(result.lastInsertRowid);
}

export function closeTrade(
  id: number,
  status: TradeStatus,
  closedPrice: number,
  pnlQuote: number,
  pnlPct: number,
): void {
  getDb()
    .prepare(`
      UPDATE trades
      SET status = ?, closed_ts = ?, closed_price = ?, pnl_quote = ?, pnl_pct = ?
      WHERE id = ?
    `)
    .run(status, Date.now(), closedPrice, pnlQuote, pnlPct, id);
}

interface TradeRow {
  id: number;
  decision_id: number | null;
  ts: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  avg_price: number;
  quote_qty: number;
  binance_order_id: string;
  oco_order_list_id: string | null;
  tp_price: number | null;
  sl_price: number | null;
  status: TradeStatus;
  closed_ts: number | null;
  closed_price: number | null;
  pnl_quote: number | null;
  pnl_pct: number | null;
  mode: 'dryrun' | 'live' | 'backtest';
  strategy_name: string;
}

function rowToRecord(r: TradeRow): TradeRecord {
  return {
    id: r.id,
    decisionId: r.decision_id,
    ts: r.ts,
    symbol: r.symbol,
    side: r.side,
    qty: r.qty,
    avgPrice: r.avg_price,
    quoteQty: r.quote_qty,
    binanceOrderId: r.binance_order_id,
    ocoOrderListId: r.oco_order_list_id,
    tpPrice: r.tp_price,
    slPrice: r.sl_price,
    status: r.status,
    closedTs: r.closed_ts,
    closedPrice: r.closed_price,
    pnlQuote: r.pnl_quote,
    pnlPct: r.pnl_pct,
    mode: r.mode,
    strategyName: r.strategy_name,
  };
}

export function getOpenTrades(symbol?: string): TradeRecord[] {
  const db = getDb();
  const rows = (symbol
    ? db.prepare('SELECT * FROM trades WHERE status = ? AND symbol = ?').all('OPEN', symbol)
    : db.prepare('SELECT * FROM trades WHERE status = ?').all('OPEN')) as TradeRow[];
  return rows.map(rowToRecord);
}

export function getRecentTrades(limit = 50): TradeRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM trades ORDER BY ts DESC LIMIT ?')
    .all(limit) as TradeRow[];
  return rows.map(rowToRecord);
}

export interface PnlSummary {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlQuote: number;
  avgPnlPct: number;
}

export function getPnlSummary(mode?: 'dryrun' | 'live' | 'backtest'): PnlSummary {
  const db = getDb();
  const rows = (mode
    ? db.prepare('SELECT pnl_quote, pnl_pct FROM trades WHERE status != ? AND mode = ?').all('OPEN', mode)
    : db.prepare('SELECT pnl_quote, pnl_pct FROM trades WHERE status != ?').all('OPEN')) as { pnl_quote: number; pnl_pct: number }[];

  const trades = rows.length;
  const wins = rows.filter((r) => r.pnl_quote > 0).length;
  const losses = rows.filter((r) => r.pnl_quote <= 0).length;
  const totalPnlQuote = rows.reduce((s, r) => s + (r.pnl_quote ?? 0), 0);
  const avgPnlPct = trades > 0 ? rows.reduce((s, r) => s + (r.pnl_pct ?? 0), 0) / trades : 0;

  return {
    trades,
    wins,
    losses,
    winRate: trades > 0 ? wins / trades : 0,
    totalPnlQuote,
    avgPnlPct,
  };
}
