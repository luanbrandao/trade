import { getDb } from '../storage/db';
import { LlmCost } from './types';

export function collectLlmCost(strategyName: string): LlmCost {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT llm_model AS model,
              COALESCE(SUM(llm_input_tokens), 0) AS input_tokens,
              COALESCE(SUM(llm_output_tokens), 0) AS output_tokens,
              COALESCE(SUM(llm_cost_usd), 0) AS cost_usd
       FROM decisions
       WHERE strategy_name = ? AND mode = 'dryrun'
       GROUP BY llm_model`,
    )
    .all(strategyName) as {
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }[];

  const byModel: Record<string, number> = {};
  let totalUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const r of rows) {
    const model = r.model ?? 'unknown';
    byModel[model] = (byModel[model] ?? 0) + r.cost_usd;
    totalUsd += r.cost_usd;
    inputTokens += r.input_tokens;
    outputTokens += r.output_tokens;
  }

  return { totalUsd, inputTokens, outputTokens, byModel };
}
