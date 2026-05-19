import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/config';
import { decideTradeTool, forceDecideTrade, DECIDE_TRADE_TOOL_NAME } from './tools';
import { TradeDecision, TradeDecisionSchema } from './schema';
import { buildSystemPrompt, buildUserPrompt, MarketSnapshot, PromptContext } from './prompt';

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

const PRICING_PER_MTOKEN: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

function estimateCostUsd(model: string, u: DecisionUsage): number {
  const p = PRICING_PER_MTOKEN[model];
  if (!p) return 0;
  const million = 1_000_000;
  return (
    (u.inputTokens * p.input) / million +
    (u.outputTokens * p.output) / million +
    (u.cacheReadInputTokens * p.cacheRead) / million +
    (u.cacheCreationInputTokens * p.cacheWrite) / million
  );
}

export class ClaudeClient {
  private sdk: Anthropic;
  private model: string;
  private effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  constructor() {
    if (!config.anthropic.apiKey) {
      throw new Error('ClaudeClient requires ANTHROPIC_API_KEY in .env');
    }
    this.sdk = new Anthropic({ apiKey: config.anthropic.apiKey });
    this.model = config.anthropic.model;
    this.effort = config.anthropic.effort;
  }

  async decide(snapshot: MarketSnapshot, ctx: PromptContext): Promise<DecisionResult> {
    const systemPrompt = buildSystemPrompt(ctx);
    const userPrompt = buildUserPrompt(snapshot, ctx);

    const response = await this.sdk.messages.create({
      model: this.model,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort },
      tools: [decideTradeTool],
      tool_choice: forceDecideTrade,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === DECIDE_TRADE_TOOL_NAME,
    );

    if (!toolUse) {
      throw new Error(
        `Claude did not call ${DECIDE_TRADE_TOOL_NAME}. stop_reason=${response.stop_reason}`,
      );
    }

    const parsed = TradeDecisionSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      throw new Error(`Invalid decision schema: ${parsed.error.message}`);
    }

    const rrRatio = parsed.data.takeProfitPercent / parsed.data.stopLossPercent;
    if (parsed.data.action !== 'HOLD' && rrRatio < ctx.minRrRatio) {
      throw new Error(
        `R/R ${rrRatio.toFixed(2)}:1 below floor ${ctx.minRrRatio}:1 — decision violates system constraints`,
      );
    }

    const usage: DecisionUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      costUsd: 0,
    };
    usage.costUsd = estimateCostUsd(this.model, usage);

    return {
      decision: parsed.data,
      usage,
      stopReason: response.stop_reason,
      model: response.model,
    };
  }
}
