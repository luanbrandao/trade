import { getDb } from '../storage/db';

export interface SymbolPerf {
  symbol: string;
  trades: number;
  winRate: number;
  avgPnlPct: number;
}

export interface ConfidenceBucket {
  range: string;
  trades: number;
  winRate: number;
}

export interface PerformanceSummary {
  totalClosed: number;
  winRate: number;
  avgPnlPct: number;
  /** SL_HIT trades whose MFE reached the original TP distance — evidence stops sit inside noise. */
  slStoppedBeforeTpCount: number;
  slCount: number;
  bySymbol: SymbolPerf[];
  byConfidence: ConfidenceBucket[];
}

interface PerfRow {
  symbol: string;
  outcome: string;
  pnl_pct: number;
  mfe_pct: number | null;
  confidence: number | null;
  tp_price: number | null;
  avg_price: number;
  side: string;
}

/**
 * Aggregates the last `lastN` closed trades (postmortems joined to trades and
 * the originating decisions). Injected into the LLM prompt so the model sees
 * how its recent calls actually resolved, and used to sanity-check whether the
 * configured confidence threshold is calibrated.
 */
export function getPerformanceSummary(
  mode: 'dryrun' | 'live' | 'backtest',
  lastN = 50,
): PerformanceSummary | null {
  const rows = getDb()
    .prepare(
      `SELECT t.symbol, p.outcome, p.pnl_pct, p.mfe_pct, d.confidence,
              t.tp_price, t.avg_price, t.side
       FROM postmortems p
       JOIN trades t ON t.id = p.trade_id
       LEFT JOIN decisions d ON d.id = t.decision_id
       WHERE t.mode = ?
       ORDER BY p.closed_ts DESC
       LIMIT ?`,
    )
    .all(mode, lastN) as PerfRow[];

  if (rows.length === 0) return null;

  const wins = rows.filter((r) => r.pnl_pct > 0).length;
  const avgPnlPct = rows.reduce((s, r) => s + r.pnl_pct, 0) / rows.length;

  const slRows = rows.filter((r) => r.outcome === 'SL_HIT');
  const slStoppedBeforeTp = slRows.filter((r) => {
    if (r.mfe_pct == null || r.tp_price == null || r.avg_price <= 0) return false;
    const tpDistancePct = (Math.abs(r.tp_price - r.avg_price) / r.avg_price) * 100;
    return r.mfe_pct >= tpDistancePct;
  }).length;

  const bySymbolMap = new Map<string, PerfRow[]>();
  for (const r of rows) {
    if (!bySymbolMap.has(r.symbol)) bySymbolMap.set(r.symbol, []);
    bySymbolMap.get(r.symbol)!.push(r);
  }
  const bySymbol: SymbolPerf[] = [...bySymbolMap.entries()].map(([symbol, rs]) => ({
    symbol,
    trades: rs.length,
    winRate: rs.filter((r) => r.pnl_pct > 0).length / rs.length,
    avgPnlPct: rs.reduce((s, r) => s + r.pnl_pct, 0) / rs.length,
  }));

  const buckets: Array<{ range: string; min: number; max: number }> = [
    { range: '70-79', min: 70, max: 80 },
    { range: '80-89', min: 80, max: 90 },
    { range: '90-100', min: 90, max: 101 },
  ];
  const byConfidence: ConfidenceBucket[] = buckets
    .map(({ range, min, max }) => {
      const rs = rows.filter((r) => r.confidence != null && r.confidence >= min && r.confidence < max);
      return {
        range,
        trades: rs.length,
        winRate: rs.length > 0 ? rs.filter((r) => r.pnl_pct > 0).length / rs.length : 0,
      };
    })
    .filter((b) => b.trades > 0);

  return {
    totalClosed: rows.length,
    winRate: wins / rows.length,
    avgPnlPct,
    slStoppedBeforeTpCount: slStoppedBeforeTp,
    slCount: slRows.length,
    bySymbol,
    byConfidence,
  };
}
