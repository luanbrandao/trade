import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';

process.env.DB_PATH = path.resolve('./data/test-stats-reader.db');

import { config } from '../config/config';
import { getDb } from '../storage/db';
import { insertTrade, TradeRecord } from '../storage/trades';
import { insertDecision, DecisionRecord } from '../storage/decisions';
import { StatsReader } from './stats-reader';
import { PriceCache } from './binance-prices';
import { LoopStatus } from './types';

// Snapshot queries config.trading.strategyName, so seed data must use the
// same value (the STRATEGY_NAME env is unreliable here due to import hoisting).
const STRAT = config.trading.strategyName;

function resetDb() {
  const db = getDb();
  db.exec('DELETE FROM trades');
  db.exec('DELETE FROM decisions');
}

function closedTrade(over: Partial<TradeRecord>): TradeRecord {
  return {
    decisionId: null,
    ts: 1_000_000,
    symbol: 'BTCUSDT',
    side: 'BUY',
    qty: 0.001,
    avgPrice: 60000,
    quoteQty: 60,
    binanceOrderId: 'SIM-c',
    ocoOrderListId: null,
    tpPrice: 61200,
    slPrice: 59400,
    status: 'TP_FILLED',
    closedTs: 2_000_000,
    closedPrice: 61200,
    pnlQuote: 1.2,
    pnlPct: 2.0,
    mode: 'dryrun',
    strategyName: STRAT,
    ...over,
  };
}

function openTrade(over: Partial<TradeRecord>): TradeRecord {
  return {
    decisionId: null,
    ts: 3_000_000,
    symbol: 'ETHUSDT',
    side: 'BUY',
    qty: 0.01,
    avgPrice: 3000,
    quoteQty: 30,
    binanceOrderId: 'SIM-o',
    ocoOrderListId: null,
    tpPrice: 3100,
    slPrice: 2900,
    status: 'OPEN',
    closedTs: null,
    closedPrice: null,
    pnlQuote: null,
    pnlPct: null,
    mode: 'dryrun',
    strategyName: STRAT,
    ...over,
  };
}

function decision(over: Partial<DecisionRecord>): DecisionRecord {
  return {
    ts: 1_500_000,
    symbol: 'BTCUSDT',
    action: 'BUY',
    confidence: 80,
    reason: 'r',
    stopLossPct: 1,
    takeProfitPct: 2,
    timeHorizonMinutes: 60,
    priceAtDecision: 60000,
    llmModel: 'claude-opus-4-7',
    llmInputTokens: 1000,
    llmOutputTokens: 100,
    llmCostUsd: 0.01,
    executed: true,
    skipReason: null,
    mode: 'dryrun',
    strategyName: STRAT,
    ...over,
  };
}

class FakePub {
  async getPrice(symbol: string) {
    return { symbol, price: '3050' }; // ETH up 50 from 3000 entry
  }
}

function loopStub(): LoopStatus {
  return { running: false, pid: null, startedAt: null, uptimeSec: 0, lastTickAt: null, adopted: false };
}

describe('StatsReader.snapshot', () => {
  beforeEach(() => resetDb());

  it('builds KPIs, open PnL, decisions, and llm cost', async () => {
    insertTrade(closedTrade({ side: 'BUY', pnlQuote: 1.2, pnlPct: 2.0, status: 'TP_FILLED' }));
    insertTrade(closedTrade({ side: 'SELL', pnlQuote: -0.6, pnlPct: -1.0, status: 'SL_FILLED', binanceOrderId: 'SIM-c2' }));
    insertTrade(openTrade({}));
    insertDecision(decision({}));

    const reader = new StatsReader(new PriceCache(new FakePub(), 15_000, () => 0));
    const snap = await reader.snapshot(loopStub());

    expect(snap.stats.tradesClosed).toBe(2);
    expect(snap.stats.tradesOpen).toBe(1);
    expect(snap.stats.winsBuy).toBe(1);
    expect(snap.stats.totalBuy).toBe(1);
    expect(snap.stats.winsSell).toBe(0);
    expect(snap.stats.totalSell).toBe(1);
    expect(snap.stats.winRateTotal).toBeCloseTo(0.5, 6);
    expect(snap.stats.realizedPnlQuote).toBeCloseTo(0.6, 6);
    expect(snap.stats.equityNow).toBeCloseTo(1000.6, 6);

    // open ETH: (3050 - 3000) * 0.01 = 0.5
    expect(snap.openTrades).toHaveLength(1);
    expect(snap.openTrades[0].currentPrice).toBe(3050);
    expect(snap.openTrades[0].stop).toBe(2900);
    expect(snap.openTrades[0].target).toBe(3100);
    expect(snap.openTrades[0].pnlQuote).toBeCloseTo(0.5, 6);
    expect(snap.stats.openPnlQuote).toBeCloseTo(0.5, 6);

    expect(snap.closedTrades).toHaveLength(2);
    expect(snap.decisions).toHaveLength(1);
    expect(snap.decisions[0].action).toBe('BUY');

    expect(snap.llmCost.totalUsd).toBeCloseTo(0.01, 6);
    expect(snap.stats.dailyGate.allowed).toBe(true);
    expect(snap.loop.lastTickAt).toBe(1_500_000); // MAX(decisions.ts)
  });

  it('returns empty arrays and zeros for an empty DB', async () => {
    const reader = new StatsReader(new PriceCache(new FakePub(), 15_000, () => 0));
    const snap = await reader.snapshot(loopStub());
    expect(snap.stats.tradesClosed).toBe(0);
    expect(snap.openTrades).toEqual([]);
    expect(snap.closedTrades).toEqual([]);
    expect(snap.decisions).toEqual([]);
    expect(snap.loop.lastTickAt).toBeNull();
  });
});
