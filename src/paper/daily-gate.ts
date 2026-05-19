import { getDb } from '../storage/db';
import { config } from '../config/config';

export interface GateResult {
  allowed: boolean;
  reason?: string;
  ddPct: number;
  streak: number;
}

function utcMidnightToday(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function checkDailyGate(): GateResult {
  const start = utcMidnightToday();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT pnl_quote, closed_ts
       FROM trades
       WHERE closed_ts IS NOT NULL
         AND closed_ts >= ?
         AND mode = 'dryrun'
         AND status IN ('TP_FILLED','SL_FILLED','CANCELED')
       ORDER BY closed_ts ASC`,
    )
    .all(start) as { pnl_quote: number; closed_ts: number }[];

  const negSum = rows.filter((r) => r.pnl_quote < 0).reduce((s, r) => s + r.pnl_quote, 0);
  const ddPct = (Math.abs(negSum) / config.trading.accountEquityUsd) * 100;

  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].pnl_quote < 0) streak += 1;
    else break;
  }

  if (ddPct >= config.trading.maxDailyLossPct) {
    return {
      allowed: false,
      reason: `Daily DD ${ddPct.toFixed(2)}% >= cap ${config.trading.maxDailyLossPct}%`,
      ddPct,
      streak,
    };
  }
  if (streak >= config.trading.maxDailyLosses) {
    return {
      allowed: false,
      reason: `Loss streak ${streak} >= cap ${config.trading.maxDailyLosses}`,
      ddPct,
      streak,
    };
  }
  return { allowed: true, ddPct, streak };
}
