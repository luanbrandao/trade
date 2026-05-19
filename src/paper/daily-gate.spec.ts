import { describe, it, expect, beforeEach } from 'vitest';

process.env.ACCOUNT_EQUITY_USD = '1000';
process.env.MAX_DAILY_LOSS_PCT = '3.0';
process.env.MAX_DAILY_LOSSES = '3';

import { getDb } from '../storage/db';
import { insertTrade, TradeRecord } from '../storage/trades';
import { checkDailyGate } from './daily-gate';

function resetDb() {
  const db = getDb();
  db.exec('DELETE FROM trades');
  db.exec('DELETE FROM decisions');
}

function makeClosedTrade(opts: { closedTs: number; pnlQuote: number; pnlPct: number }): TradeRecord {
  return {
    decisionId: null,
    ts: opts.closedTs - 3_600_000,
    symbol: 'BTCUSDT',
    side: 'BUY',
    qty: 0.001,
    avgPrice: 60000,
    quoteQty: 60,
    binanceOrderId: `SIM-${opts.closedTs}`,
    ocoOrderListId: null,
    tpPrice: 61200,
    slPrice: 59400,
    status: opts.pnlQuote > 0 ? 'TP_FILLED' : 'SL_FILLED',
    closedTs: opts.closedTs,
    closedPrice: 60000 + opts.pnlQuote / 0.001,
    pnlQuote: opts.pnlQuote,
    pnlPct: opts.pnlPct,
    mode: 'dryrun',
    strategyName: 'test',
  };
}

function todayUtcMidnight(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

describe('checkDailyGate', () => {
  beforeEach(() => resetDb());

  it('allows when no trades today', () => {
    expect(checkDailyGate().allowed).toBe(true);
  });

  it('allows after 1 small loss', () => {
    insertTrade(makeClosedTrade({ closedTs: todayUtcMidnight() + 3_600_000, pnlQuote: -10, pnlPct: -1.0 }));
    expect(checkDailyGate().allowed).toBe(true);
  });

  it('blocks when daily DD >= MAX_DAILY_LOSS_PCT', () => {
    const start = todayUtcMidnight() + 3_600_000;
    insertTrade(makeClosedTrade({ closedTs: start, pnlQuote: -20, pnlPct: -2.0 }));
    insertTrade(makeClosedTrade({ closedTs: start + 1000, pnlQuote: -15, pnlPct: -1.5 }));
    const result = checkDailyGate();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('DD');
  });

  it('blocks on consecutive-loss streak >= MAX_DAILY_LOSSES', () => {
    const start = todayUtcMidnight() + 3_600_000;
    insertTrade(makeClosedTrade({ closedTs: start, pnlQuote: -5, pnlPct: -0.5 }));
    insertTrade(makeClosedTrade({ closedTs: start + 1000, pnlQuote: -5, pnlPct: -0.5 }));
    insertTrade(makeClosedTrade({ closedTs: start + 2000, pnlQuote: -5, pnlPct: -0.5 }));
    const result = checkDailyGate();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('streak');
  });

  it('streak resets after a win', () => {
    const start = todayUtcMidnight() + 3_600_000;
    insertTrade(makeClosedTrade({ closedTs: start, pnlQuote: -5, pnlPct: -0.5 }));
    insertTrade(makeClosedTrade({ closedTs: start + 1000, pnlQuote: -5, pnlPct: -0.5 }));
    insertTrade(makeClosedTrade({ closedTs: start + 2000, pnlQuote: +5, pnlPct: +0.5 }));
    insertTrade(makeClosedTrade({ closedTs: start + 3000, pnlQuote: -5, pnlPct: -0.5 }));
    const result = checkDailyGate();
    expect(result.allowed).toBe(true);
  });

  it('ignores trades from prior UTC day', () => {
    const yesterday = todayUtcMidnight() - 12 * 3_600_000;
    insertTrade(makeClosedTrade({ closedTs: yesterday, pnlQuote: -100, pnlPct: -10 }));
    expect(checkDailyGate().allowed).toBe(true);
  });

  it('ignores live trades when in dryrun mode', () => {
    const start = todayUtcMidnight() + 3_600_000;
    const liveLoser = { ...makeClosedTrade({ closedTs: start, pnlQuote: -50, pnlPct: -5 }), mode: 'live' as const };
    insertTrade(liveLoser);
    expect(checkDailyGate().allowed).toBe(true);
  });
});
