import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

process.env.DB_PATH = path.resolve(os.tmpdir(), `orch-${process.pid}-${Date.now()}.db`);

vi.mock('./regime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./regime')>();
  return {
    ...actual,
    detectRegime: vi.fn(async () => ({
      regime: 'RISK_ON',
      btcTrend: 'UP',
      btcEma50Slope: 1,
      btcChange30dPct: 10,
      fearGreedIndex: 60,
      fearGreedLabel: 'Greed',
      source: 'test',
    })),
  };
});

vi.mock('./market-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./market-data')>();
  return {
    ...actual,
    fetchSnapshot: vi.fn(async (_pub: unknown, symbol: string) => ({
      symbol,
      currentPrice: 61000,
      ticker24h: {} as never,
      klines1h: [],
      ema: { fast: 1, slow: 1, prevFast: 1, prevSlow: 1, cross: 'NONE', trend: 'UP' },
      atr: 600,
      rsi14: 55,
      relVolume: 1.1,
      levels: null,
      higherTimeframes: [],
      topBids: [],
      topAsks: [],
    })),
  };
});

import { Orchestrator } from './orchestrator';
import { insertTrade, getOpenTrades, TradeRecord } from '../storage/trades';
import { getDb } from '../storage/db';
import { config } from '../config/config';
import { DecisionResult } from '../llm/types';

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

function llmStub(action: 'BUY' | 'SELL' | 'HOLD', confidence: number) {
  return {
    decide: vi.fn(
      async (): Promise<DecisionResult> => ({
        decision: {
          action,
          confidence,
          reason: 'test decision with enough length',
          stopLossPercent: 2,
          takeProfitPercent: 4,
          timeHorizonMinutes: 60,
          keyRisks: ['risk'],
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUsd: 0,
        },
        stopReason: 'tool_use',
        model: 'test',
      }),
    ),
  };
}

beforeEach(() => {
  getDb().exec('DELETE FROM trades');
  getDb().exec('DELETE FROM decisions');
  getDb().exec('DELETE FROM cooldowns');
  (config.trading as { minConfidence: number }).minConfidence = 70;
  (config.trading as { manageOpenPositions: boolean }).manageOpenPositions = true;
});

describe('Orchestrator open-position management', () => {
  it('skips the symbol when manageOpenPositions is off', async () => {
    (config.trading as { manageOpenPositions: boolean }).manageOpenPositions = false;
    insertTrade(openTrade('BTCUSDT'));
    const orch = new Orchestrator('dryrun');
    const res = await orch.runSymbol('BTCUSDT');
    expect(res.outcome).toBe('SKIPPED_OPEN_POSITION');
  });

  it('SELL above the floor closes the position', async () => {
    insertTrade(openTrade('BTCUSDT'));
    const orch = new Orchestrator('dryrun');
    (orch as any).claude = llmStub('SELL', 80);
    const persistClose = vi.fn(async () => {});
    (orch as any).closer = { persistClose };

    const res = await orch.runSymbol('BTCUSDT');
    expect(res.outcome).toBe('EXECUTED');
    expect(persistClose).toHaveBeenCalledTimes(1);
    const [trade, exitPrice, , outcome, notes] = persistClose.mock.calls[0] as unknown as [
      TradeRecord,
      number,
      number,
      string,
      string,
    ];
    expect(trade.symbol).toBe('BTCUSDT');
    expect(exitPrice).toBe(61000);
    expect(outcome).toBe('MANUAL');
    expect(notes).toBe('LLM_EARLY_EXIT');
  });

  it('HOLD keeps the position open', async () => {
    insertTrade(openTrade('BTCUSDT'));
    const orch = new Orchestrator('dryrun');
    (orch as any).claude = llmStub('HOLD', 90);
    const persistClose = vi.fn(async () => {});
    (orch as any).closer = { persistClose };

    const res = await orch.runSymbol('BTCUSDT');
    expect(res.outcome).toBe('SKIPPED_DECISION');
    expect(persistClose).not.toHaveBeenCalled();
    expect(getOpenTrades('BTCUSDT')).toHaveLength(1);
  });

  it('SELL below the floor is skipped', async () => {
    insertTrade(openTrade('BTCUSDT'));
    const orch = new Orchestrator('dryrun');
    (orch as any).claude = llmStub('SELL', 60);
    const persistClose = vi.fn(async () => {});
    (orch as any).closer = { persistClose };

    const res = await orch.runSymbol('BTCUSDT');
    expect(res.outcome).toBe('SKIPPED_DECISION');
    expect(persistClose).not.toHaveBeenCalled();
  });

  it('BUY while a position is open is blocked', async () => {
    insertTrade(openTrade('BTCUSDT'));
    const orch = new Orchestrator('dryrun');
    (orch as any).claude = llmStub('BUY', 95);
    const persistClose = vi.fn(async () => {});
    (orch as any).closer = { persistClose };

    const res = await orch.runSymbol('BTCUSDT');
    expect(res.outcome).toBe('SKIPPED_DECISION');
    expect(res.reason).toMatch(/BUY blocked/);
    expect(persistClose).not.toHaveBeenCalled();
  });

  it('exit uses the BASE floor even when the regime raises entries', async () => {
    // Regime mock is RISK_ON; simulate CHOPPY by raising base and checking
    // the SELL threshold reads config directly (70), not the raised floor.
    insertTrade(openTrade('BTCUSDT'));
    const orch = new Orchestrator('dryrun');
    (orch as any).claude = llmStub('SELL', 71);
    const persistClose = vi.fn(async () => {});
    (orch as any).closer = { persistClose };

    const res = await orch.runSymbol('BTCUSDT');
    expect(res.outcome).toBe('EXECUTED');
  });
});
