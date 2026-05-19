import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./data/test-strategy.db');
process.env.DB_PATH = TEST_DB;

import { getDb, closeDb } from './db';
import { insertTrade, TradeRecord } from './trades';
import { insertDecision, DecisionRecord } from './decisions';

function resetDb() {
  closeDb();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  getDb();
}

describe('strategy_name persistence', () => {
  beforeEach(() => resetDb());

  it('persists strategyName on inserted trade', () => {
    const decision: DecisionRecord = {
      ts: Date.now(),
      symbol: 'BTCUSDT',
      action: 'BUY',
      confidence: 80,
      reason: 'test',
      stopLossPct: 1,
      takeProfitPct: 2,
      timeHorizonMinutes: 60,
      priceAtDecision: 60000,
      llmModel: 'test',
      llmInputTokens: 0,
      llmOutputTokens: 0,
      llmCostUsd: 0,
      executed: false,
      skipReason: null,
      mode: 'dryrun',
      strategyName: 'ema9_21+claude_v1',
    };
    const decisionId = insertDecision(decision);

    const trade: TradeRecord = {
      decisionId,
      ts: Date.now(),
      symbol: 'BTCUSDT',
      side: 'BUY',
      qty: 0.001,
      avgPrice: 60000,
      quoteQty: 60,
      binanceOrderId: 'SIM-1',
      ocoOrderListId: null,
      tpPrice: 61200,
      slPrice: 59400,
      status: 'OPEN',
      closedTs: null,
      closedPrice: null,
      pnlQuote: null,
      pnlPct: null,
      mode: 'dryrun',
      strategyName: 'ema9_21+claude_v1',
    };
    const tradeId = insertTrade(trade);

    const db = getDb();
    const tradeRow = db.prepare('SELECT strategy_name FROM trades WHERE id = ?').get(tradeId) as { strategy_name: string };
    const decRow = db.prepare('SELECT strategy_name FROM decisions WHERE id = ?').get(decisionId) as { strategy_name: string };
    expect(tradeRow.strategy_name).toBe('ema9_21+claude_v1');
    expect(decRow.strategy_name).toBe('ema9_21+claude_v1');
  });
});
