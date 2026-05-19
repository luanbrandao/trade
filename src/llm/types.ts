import { TradeDecision } from './schema';
import { MarketSnapshot, PromptContext } from './prompt';

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

export interface DecisionResult {
  decision: TradeDecision;
  usage: DecisionUsage;
  stopReason: string | null;
  model: string;
}

export interface LlmDecider {
  decide(snapshot: MarketSnapshot, ctx: PromptContext): Promise<DecisionResult>;
}
