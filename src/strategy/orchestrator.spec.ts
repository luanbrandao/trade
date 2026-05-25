import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

process.env.DB_PATH = path.resolve(os.tmpdir(), `orch-${process.pid}-${Date.now()}.db`);

import { Orchestrator } from './orchestrator';
import { insertTrade, TradeRecord } from '../storage/trades';
import { getDb } from '../storage/db';

function openTrade(symbol: string): TradeRecord {
  return {
    decisionId: null,
    ts: Date.now(),
    symbol,
    side: 'BUY',
    qty: 0.001,
    avgPrice: 60000,
    quoteQty: 60,
    binanceOrderId: 'SIM-orch',
    ocoOrderListId: null,
    tpPrice: 61200,
    slPrice: 59400,
    status: 'OPEN',
    closedTs: null,
    closedPrice: null,
    pnlQuote: null,
    pnlPct: null,
    mode: 'dryrun',
    strategyName: 'test',
  };
}

beforeEach(() => {
  getDb().exec('DELETE FROM trades');
});

describe('Orchestrator open-position guard', () => {
  it('skips a symbol that already has an open position', async () => {
    insertTrade(openTrade('BTCUSDT'));
    const orch = new Orchestrator('dryrun');
    const res = await orch.runSymbol('BTCUSDT');
    expect(res.outcome).toBe('SKIPPED_OPEN_POSITION');
  });
});
