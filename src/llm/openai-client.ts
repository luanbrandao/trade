import OpenAI from 'openai';
import { config } from '../config/config';
import { DECIDE_TRADE_TOOL_NAME } from './tools';
import { TradeDecision, TradeDecisionSchema, TradeDecisionJsonSchema } from './schema';
import { buildSystemPrompt, buildUserPrompt, MarketSnapshot, PromptContext } from './prompt';
import { DecisionUsage, DecisionResult, LlmDecider } from './types';

const PRICING_PER_MTOKEN: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'o3-mini': { input: 1.1, output: 4.4 },
};

function estimateCostUsd(model: string, u: DecisionUsage): number {
  const p = PRICING_PER_MTOKEN[model];
  if (!p) return 0;
  const million = 1_000_000;
  return (u.inputTokens * p.input) / million + (u.outputTokens * p.output) / million;
}

export class OpenAIClient implements LlmDecider {
  private sdk: OpenAI;
  private model: string;

  constructor() {
    if (!config.openai.apiKey) {
      throw new Error('OpenAIClient requires OPENAI_API_KEY in .env');
    }
    this.sdk = new OpenAI({ apiKey: config.openai.apiKey });
    this.model = config.openai.model;
  }

  async decide(snapshot: MarketSnapshot, ctx: PromptContext): Promise<DecisionResult> {
    const systemPrompt = buildSystemPrompt(ctx);
    const userPrompt = buildUserPrompt(snapshot, ctx);

    const response = await this.sdk.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: DECIDE_TRADE_TOOL_NAME,
            description:
              'Emit your final trading decision for the given symbol. Call this tool exactly once.',
            parameters: TradeDecisionJsonSchema as unknown as Record<string, unknown>,
          },
        },
      ],
      tool_choice: {
        type: 'function',
        function: { name: DECIDE_TRADE_TOOL_NAME },
      },
    });

    const choice = response.choices[0];
    const toolCall = choice?.message?.tool_calls?.find(
      (c) => c.type === 'function' && c.function.name === DECIDE_TRADE_TOOL_NAME,
    );

    if (!toolCall || toolCall.type !== 'function') {
      throw new Error(
        `OpenAI did not call ${DECIDE_TRADE_TOOL_NAME}. finish_reason=${choice?.finish_reason}`,
      );
    }

    let input: any;
    try {
      input = JSON.parse(toolCall.function.arguments);
    } catch (err: any) {
      throw new Error(`Invalid JSON in tool call arguments: ${err.message}`);
    }

    if (input?.action === 'HOLD') {
      input.stopLossPercent = Math.max(input.stopLossPercent ?? 0.5, 0.5);
      input.takeProfitPercent = Math.max(input.takeProfitPercent ?? 1, 1);
      input.timeHorizonMinutes = Math.max(input.timeHorizonMinutes ?? 5, 5);
      if (!Array.isArray(input.keyRisks) || input.keyRisks.length === 0) {
        input.keyRisks = ['HOLD action — no entry taken'];
      }
    }

    const parsed = TradeDecisionSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`Invalid decision schema: ${parsed.error.message}`);
    }

    const decision: TradeDecision = parsed.data;
    const rrRatio = decision.takeProfitPercent / decision.stopLossPercent;
    if (decision.action !== 'HOLD' && rrRatio < ctx.minRrRatio) {
      throw new Error(
        `R/R ${rrRatio.toFixed(2)}:1 below floor ${ctx.minRrRatio}:1 — decision violates system constraints`,
      );
    }

    const usage: DecisionUsage = {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
    };
    usage.costUsd = estimateCostUsd(this.model, usage);

    return {
      decision,
      usage,
      stopReason: choice.finish_reason ?? null,
      model: response.model,
    };
  }
}
