import { z } from 'zod';

export const TradeDecisionSchema = z.object({
  action: z.enum(['BUY', 'SELL', 'HOLD']).describe(
    'The trading decision: BUY to open long, SELL to close/short, HOLD to do nothing.',
  ),
  confidence: z
    .number()
    .min(0)
    .max(100)
    .describe('Confidence in this decision, 0-100. Below MIN_CONFIDENCE the trade is skipped.'),
  reason: z
    .string()
    .min(10)
    // Truncate instead of rejecting: verbose models (e.g. deepseek) routinely
    // overshoot the soft limit, and dropping an otherwise-valid decision over a
    // long rationale is worse than clipping the text.
    .transform((s) => s.slice(0, 1000))
    .describe(
      'Concise rationale citing specific data: trend direction, indicator readings, volume, price action. No fluff.',
    ),
  stopLossPercent: z
    .number()
    .min(0.5)
    .max(10)
    .describe('Stop-loss distance from entry as percent. Tighter for trending, wider for ranging.'),
  takeProfitPercent: z
    .number()
    .min(1)
    .max(20)
    .describe('Take-profit distance from entry as percent. Must yield R/R >= MIN_RR_RATIO when paired with stopLossPercent.'),
  timeHorizonMinutes: z
    .number()
    .int()
    .min(5)
    .max(1440)
    .describe('Expected time for the trade thesis to play out, in minutes.'),
  keyRisks: z
    .array(z.string().transform((s) => s.slice(0, 200)))
    .min(1)
    .max(5)
    .describe('1-5 specific risks that would invalidate this thesis.'),
});

export type TradeDecision = z.infer<typeof TradeDecisionSchema>;

export const TradeDecisionJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['BUY', 'SELL', 'HOLD'],
      description: 'The trading decision: BUY to open long, SELL to close/short, HOLD to do nothing.',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: 'Confidence in this decision, 0-100. Below MIN_CONFIDENCE the trade is skipped.',
    },
    reason: {
      type: 'string',
      minLength: 10,
      maxLength: 1000,
      description:
        'Concise rationale citing specific data: trend direction, indicator readings, volume, price action. No fluff.',
    },
    stopLossPercent: {
      type: 'number',
      minimum: 0.5,
      maximum: 10,
      description: 'Stop-loss distance from entry as percent. Tighter for trending, wider for ranging.',
    },
    takeProfitPercent: {
      type: 'number',
      minimum: 1,
      maximum: 20,
      description: 'Take-profit distance from entry as percent. Must yield R/R >= MIN_RR_RATIO when paired with stopLossPercent.',
    },
    timeHorizonMinutes: {
      type: 'integer',
      minimum: 5,
      maximum: 1440,
      description: 'Expected time for the trade thesis to play out, in minutes.',
    },
    keyRisks: {
      type: 'array',
      items: { type: 'string', maxLength: 200 },
      minItems: 1,
      maxItems: 5,
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
} as const;
