import { getDb } from './db';

export interface DecisionRecord {
  ts: number;
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reason: string | null;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  timeHorizonMinutes: number | null;
  priceAtDecision: number;
  llmModel: string;
  llmInputTokens: number | null;
  llmOutputTokens: number | null;
  llmCostUsd: number | null;
  executed: boolean;
  skipReason: string | null;
  mode: 'dryrun' | 'live' | 'backtest';
  strategyName: string;
}

export function insertDecision(d: DecisionRecord): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO decisions (
      ts, symbol, action, confidence, reason,
      stop_loss_pct, take_profit_pct, time_horizon_minutes,
      price_at_decision, llm_model, llm_input_tokens, llm_output_tokens, llm_cost_usd,
      executed, skip_reason, mode, strategy_name
    ) VALUES (
      @ts, @symbol, @action, @confidence, @reason,
      @stopLossPct, @takeProfitPct, @timeHorizonMinutes,
      @priceAtDecision, @llmModel, @llmInputTokens, @llmOutputTokens, @llmCostUsd,
      @executed, @skipReason, @mode, @strategyName
    )
  `);
  const result = stmt.run({ ...d, executed: d.executed ? 1 : 0 });
  return Number(result.lastInsertRowid);
}

export function markDecisionExecuted(id: number): void {
  getDb().prepare('UPDATE decisions SET executed = 1 WHERE id = ?').run(id);
}

export function markDecisionSkipped(id: number, reason: string): void {
  getDb()
    .prepare('UPDATE decisions SET skip_reason = ? WHERE id = ?')
    .run(reason, id);
}

export function getRecentDecisions(limit = 50): DecisionRecord[] {
  return getDb()
    .prepare('SELECT * FROM decisions ORDER BY ts DESC LIMIT ?')
    .all(limit) as unknown as DecisionRecord[];
}
