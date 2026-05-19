import { GoogleGenAI, Type, FunctionCallingConfigMode } from '@google/genai';
import { config } from '../config/config';
import { DECIDE_TRADE_TOOL_NAME } from './tools';
import { TradeDecision, TradeDecisionSchema } from './schema';
import { buildSystemPrompt, buildUserPrompt, MarketSnapshot, PromptContext } from './prompt';
import { DecisionUsage, DecisionResult, LlmDecider } from './types';

const PRICING_PER_MTOKEN: Record<string, { input: number; output: number }> = {
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
};

function estimateCostUsd(model: string, u: DecisionUsage): number {
  const p = PRICING_PER_MTOKEN[model];
  if (!p) return 0;
  const million = 1_000_000;
  return (u.inputTokens * p.input) / million + (u.outputTokens * p.output) / million;
}

const decideTradeFunctionDeclaration = {
  name: DECIDE_TRADE_TOOL_NAME,
  description:
    'Emit your final trading decision for the given symbol. Call this tool exactly once.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      action: {
        type: Type.STRING,
        enum: ['BUY', 'SELL', 'HOLD'],
        description: 'The trading decision: BUY to open long, SELL to close/short, HOLD to do nothing.',
      },
      confidence: {
        type: Type.NUMBER,
        description: 'Confidence in this decision, 0-100. Below MIN_CONFIDENCE the trade is skipped.',
      },
      reason: {
        type: Type.STRING,
        description:
          'Concise rationale citing specific data: trend direction, indicator readings, volume, price action. No fluff. 10-500 chars.',
      },
      stopLossPercent: {
        type: Type.NUMBER,
        description: 'Stop-loss distance from entry as percent (0.5-10).',
      },
      takeProfitPercent: {
        type: Type.NUMBER,
        description: 'Take-profit distance from entry as percent (1-20). Must yield R/R >= MIN_RR_RATIO.',
      },
      timeHorizonMinutes: {
        type: Type.INTEGER,
        description: 'Expected time for the trade thesis to play out, in minutes (5-1440).',
      },
      keyRisks: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: '1-5 specific risks that would invalidate this thesis.',
      },
    },
    required: [
      'action',
      'confidence',
      'reason',
      'stopLossPercent',
      'takeProfitPercent',
      'timeHorizonMinutes',
      'keyRisks',
    ],
  },
};

export class GeminiClient implements LlmDecider {
  private sdk: GoogleGenAI;
  private model: string;

  constructor() {
    if (!config.gemini.apiKey) {
      throw new Error('GeminiClient requires GEMINI_API_KEY in .env');
    }
    this.sdk = new GoogleGenAI({ apiKey: config.gemini.apiKey });
    this.model = config.gemini.model;
  }

  async decide(snapshot: MarketSnapshot, ctx: PromptContext): Promise<DecisionResult> {
    const systemPrompt = buildSystemPrompt(ctx);
    const userPrompt = buildUserPrompt(snapshot, ctx);

    const response = await this.sdk.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: systemPrompt,
        tools: [{ functionDeclarations: [decideTradeFunctionDeclaration] }],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: [DECIDE_TRADE_TOOL_NAME],
          },
        },
      },
    });

    const calls = response.functionCalls ?? [];
    const call = calls.find((c) => c.name === DECIDE_TRADE_TOOL_NAME);

    if (!call) {
      throw new Error(
        `Gemini did not call ${DECIDE_TRADE_TOOL_NAME}. finishReason=${response.candidates?.[0]?.finishReason ?? 'unknown'}`,
      );
    }

    const input: any = call.args ?? {};
    if (input.action === 'HOLD') {
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

    const meta = response.usageMetadata;
    const usage: DecisionUsage = {
      inputTokens: meta?.promptTokenCount ?? 0,
      outputTokens: meta?.candidatesTokenCount ?? 0,
      cacheReadInputTokens: meta?.cachedContentTokenCount ?? 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
    };
    usage.costUsd = estimateCostUsd(this.model, usage);

    return {
      decision,
      usage,
      stopReason: response.candidates?.[0]?.finishReason ?? null,
      model: this.model,
    };
  }
}
