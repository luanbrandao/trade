import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';

process.env.DB_PATH = path.resolve('./data/test-llm-cost.db');

import { getDb } from '../storage/db';
import { insertDecision, DecisionRecord } from '../storage/decisions';
import { collectLlmCost } from './llm-cost';

function resetDb() {
  const db = getDb();
  db.exec('DELETE FROM trades');
  db.exec('DELETE FROM decisions');
}

function makeDecision(over: Partial<DecisionRecord>): DecisionRecord {
  return {
    ts: Date.now(),
    symbol: 'BTCUSDT',
    action: 'HOLD',
    confidence: 50,
    reason: 'x',
    stopLossPct: null,
    takeProfitPct: null,
    timeHorizonMinutes: null,
    priceAtDecision: 60000,
    llmModel: 'claude-opus-4-7',
    llmInputTokens: 1000,
    llmOutputTokens: 100,
    llmCostUsd: 0.01,
    executed: false,
    skipReason: null,
    mode: 'dryrun',
    strategyName: 'test',
    ...over,
  };
}

describe('collectLlmCost', () => {
  beforeEach(() => resetDb());

  it('returns zeros when no decisions', () => {
    const c = collectLlmCost('test');
    expect(c.totalUsd).toBe(0);
    expect(c.inputTokens).toBe(0);
    expect(c.outputTokens).toBe(0);
    expect(c.byModel).toEqual({});
  });

  it('sums cost and tokens for the strategy', () => {
    insertDecision(makeDecision({ llmCostUsd: 0.01, llmInputTokens: 1000, llmOutputTokens: 100 }));
    insertDecision(makeDecision({ llmCostUsd: 0.02, llmInputTokens: 500, llmOutputTokens: 50 }));
    const c = collectLlmCost('test');
    expect(c.totalUsd).toBeCloseTo(0.03, 6);
    expect(c.inputTokens).toBe(1500);
    expect(c.outputTokens).toBe(150);
    expect(c.byModel['claude-opus-4-7']).toBeCloseTo(0.03, 6);
  });

  it('breaks cost down by model', () => {
    insertDecision(makeDecision({ llmModel: 'claude-opus-4-7', llmCostUsd: 0.01 }));
    insertDecision(makeDecision({ llmModel: 'gpt-4o-mini', llmCostUsd: 0.002 }));
    const c = collectLlmCost('test');
    expect(c.byModel['claude-opus-4-7']).toBeCloseTo(0.01, 6);
    expect(c.byModel['gpt-4o-mini']).toBeCloseTo(0.002, 6);
  });

  it('ignores decisions from other strategies', () => {
    insertDecision(makeDecision({ strategyName: 'other', llmCostUsd: 5 }));
    const c = collectLlmCost('test');
    expect(c.totalUsd).toBe(0);
  });
});
