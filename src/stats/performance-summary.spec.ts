import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';

process.env.DB_PATH = path.resolve('./data/test-performance-summary.db');

import { getDb } from '../storage/db';
import { insertTrade, TradeRecord } from '../storage/trades';
import { insertDecision } from '../storage/decisions';
import { insertPostmortem, PostmortemOutcome } from '../storage/postmortems';
import { getPerformanceSummary } from './performance-summary';

function resetDb() {
  const db = getDb();
  db.exec('DELETE FROM postmortems');
  db.exec('DELETE FROM trades');
  db.exec('DELETE FROM decisions');
}

function seedClosedTrade(opts: {
  symbol: string;
  confidence: number;
  pnlPct: number;
  outcome: PostmortemOutcome;
  mfePct?: number | null;
  tpPct?: number;
  regime?: string;
}): void {
  const entry = 100;
  const decisionId = insertDecision({
    ts: Date.now(),
    symbol: opts.symbol,
    action: 'BUY',
    regime: opts.regime ?? null,
    confidence: opts.confidence,
    reason: 'test',
    stopLossPct: 2,
    takeProfitPct: opts.tpPct ?? 4,
    timeHorizonMinutes: 60,
    priceAtDecision: entry,
    llmModel: 'test',
    llmInputTokens: 0,
    llmOutputTokens: 0,
    llmCostUsd: 0,
    executed: true,
    skipReason: null,
    mode: 'dryrun',
    strategyName: 'test',
  });

  const trade: TradeRecord = {
    decisionId,
    ts: Date.now() - 60_000,
    symbol: opts.symbol,
    side: 'BUY',
    qty: 1,
    avgPrice: entry,
    quoteQty: entry,
    binanceOrderId: `T-${Math.random()}`,
    ocoOrderListId: null,
    tpPrice: entry * (1 + (opts.tpPct ?? 4) / 100),
    slPrice: entry * 0.98,
    status: opts.pnlPct > 0 ? 'TP_FILLED' : 'SL_FILLED',
    closedTs: Date.now(),
    closedPrice: entry * (1 + opts.pnlPct / 100),
    pnlQuote: opts.pnlPct,
    pnlPct: opts.pnlPct,
    mode: 'dryrun',
    strategyName: 'test',
  };
  const tradeId = insertTrade(trade);

  insertPostmortem({
    tradeId,
    closedTs: Date.now(),
    outcome: opts.outcome,
    pnlQuote: opts.pnlPct,
    pnlPct: opts.pnlPct,
    holdingMinutes: 60,
    maePct: null,
    mfePct: opts.mfePct ?? null,
    classification: opts.pnlPct > 0 ? 'TRUE_POSITIVE' : 'FALSE_POSITIVE',
    notes: null,
  });
}

describe('getPerformanceSummary', () => {
  beforeEach(() => resetDb());

  it('returns null with no closed trades', () => {
    expect(getPerformanceSummary('dryrun')).toBeNull();
  });

  it('aggregates win rate, avg pnl and per-symbol stats', () => {
    seedClosedTrade({ symbol: 'BTCUSDT', confidence: 75, pnlPct: 4, outcome: 'TP_HIT' });
    seedClosedTrade({ symbol: 'BTCUSDT', confidence: 72, pnlPct: -2, outcome: 'SL_HIT' });
    seedClosedTrade({ symbol: 'ETHUSDT', confidence: 85, pnlPct: 4, outcome: 'TP_HIT' });

    const s = getPerformanceSummary('dryrun')!;
    expect(s.totalClosed).toBe(3);
    expect(s.winRate).toBeCloseTo(2 / 3, 5);
    expect(s.bySymbol.find((x) => x.symbol === 'BTCUSDT')!.trades).toBe(2);
    expect(s.bySymbol.find((x) => x.symbol === 'ETHUSDT')!.winRate).toBe(1);
  });

  it('counts SL trades whose MFE reached the TP distance (stops too tight)', () => {
    // TP 4% away; MFE 5% means price reached TP territory after the stop fired.
    seedClosedTrade({ symbol: 'BTCUSDT', confidence: 75, pnlPct: -2, outcome: 'SL_HIT', mfePct: 5, tpPct: 4 });
    seedClosedTrade({ symbol: 'BTCUSDT', confidence: 75, pnlPct: -2, outcome: 'SL_HIT', mfePct: 1, tpPct: 4 });

    const s = getPerformanceSummary('dryrun')!;
    expect(s.slCount).toBe(2);
    expect(s.slStoppedBeforeTpCount).toBe(1);
  });

  it('buckets win rate by decision confidence', () => {
    seedClosedTrade({ symbol: 'BTCUSDT', confidence: 72, pnlPct: 4, outcome: 'TP_HIT' });
    seedClosedTrade({ symbol: 'BTCUSDT', confidence: 74, pnlPct: -2, outcome: 'SL_HIT' });
    seedClosedTrade({ symbol: 'BTCUSDT', confidence: 92, pnlPct: 4, outcome: 'TP_HIT' });

    const s = getPerformanceSummary('dryrun')!;
    const low = s.byConfidence.find((b) => b.range === '70-79')!;
    expect(low.trades).toBe(2);
    expect(low.winRate).toBeCloseTo(0.5, 5);
    const high = s.byConfidence.find((b) => b.range === '90-100')!;
    expect(high.trades).toBe(1);
    expect(high.winRate).toBe(1);
  });

  it('aggregates win rate by regime at entry', () => {
    seedClosedTrade({ symbol: 'BTCUSDT', confidence: 75, pnlPct: 4, outcome: 'TP_HIT', regime: 'RISK_ON' });
    seedClosedTrade({ symbol: 'BTCUSDT', confidence: 75, pnlPct: 4, outcome: 'TP_HIT', regime: 'RISK_ON' });
    seedClosedTrade({ symbol: 'BTCUSDT', confidence: 75, pnlPct: -2, outcome: 'SL_HIT', regime: 'CHOPPY' });
    seedClosedTrade({ symbol: 'BTCUSDT', confidence: 75, pnlPct: 4, outcome: 'TP_HIT' }); // no regime

    const s = getPerformanceSummary('dryrun')!;
    const riskOn = s.byRegime.find((r) => r.regime === 'RISK_ON')!;
    expect(riskOn.trades).toBe(2);
    expect(riskOn.winRate).toBe(1);
    const choppy = s.byRegime.find((r) => r.regime === 'CHOPPY')!;
    expect(choppy.trades).toBe(1);
    expect(choppy.winRate).toBe(0);
    // rows without regime don't create a bucket
    expect(s.byRegime).toHaveLength(2);
  });

  it('filters by mode', () => {
    seedClosedTrade({ symbol: 'BTCUSDT', confidence: 75, pnlPct: 4, outcome: 'TP_HIT' });
    expect(getPerformanceSummary('live')).toBeNull();
  });
});
