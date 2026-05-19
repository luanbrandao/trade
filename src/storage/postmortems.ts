import { getDb } from './db';

export type PostmortemOutcome = 'TP_HIT' | 'SL_HIT' | 'TIMEOUT' | 'MANUAL' | 'REGIME_MISMATCH';
export type PostmortemClassification = 'TRUE_POSITIVE' | 'FALSE_POSITIVE' | 'TIMEOUT_WIN' | 'TIMEOUT_LOSS';

export interface PostmortemRecord {
  id?: number;
  tradeId: number;
  closedTs: number;
  outcome: PostmortemOutcome;
  pnlQuote: number;
  pnlPct: number;
  holdingMinutes: number;
  maePct: number | null;
  mfePct: number | null;
  classification: PostmortemClassification;
  notes: string | null;
}

export function insertPostmortem(p: PostmortemRecord): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO postmortems (
      trade_id, closed_ts, outcome, pnl_quote, pnl_pct, holding_minutes,
      mae_pct, mfe_pct, classification, notes
    ) VALUES (
      @tradeId, @closedTs, @outcome, @pnlQuote, @pnlPct, @holdingMinutes,
      @maePct, @mfePct, @classification, @notes
    )
  `);
  const result = stmt.run(p);
  return Number(result.lastInsertRowid);
}

export function getRecentPostmortems(limit = 50): PostmortemRecord[] {
  return getDb()
    .prepare('SELECT * FROM postmortems ORDER BY closed_ts DESC LIMIT ?')
    .all(limit) as unknown as PostmortemRecord[];
}

export function postmortemExistsForTrade(tradeId: number): boolean {
  const row = getDb().prepare('SELECT 1 FROM postmortems WHERE trade_id = ? LIMIT 1').get(tradeId);
  return row !== undefined;
}
