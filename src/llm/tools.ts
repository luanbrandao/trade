import Anthropic from '@anthropic-ai/sdk';
import { TradeDecisionJsonSchema } from './schema';

export const DECIDE_TRADE_TOOL_NAME = 'decide_trade';

export const decideTradeTool: Anthropic.Tool = {
  name: DECIDE_TRADE_TOOL_NAME,
  description:
    'Emit your final trading decision for the given symbol. Call this tool exactly once. Do not output prose answers; the tool input IS the answer.',
  input_schema: TradeDecisionJsonSchema as unknown as Anthropic.Tool.InputSchema,
};

export const forceDecideTrade: Anthropic.ToolChoice = {
  type: 'tool',
  name: DECIDE_TRADE_TOOL_NAME,
};
