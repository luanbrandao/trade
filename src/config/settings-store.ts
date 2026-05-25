import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

// Single source of truth for the per-trade notional cap. Lives here (not in
// config.ts) to stay dependency-free and avoid an import cycle: config.ts
// imports this module for the env overlay and re-exports this constant.
export const MAX_TRADE_AMOUNT_USD = 10000;

export const LLM_PROVIDERS = ['anthropic', 'openai', 'gemini', 'deepseek'] as const;
export const KLINE_INTERVALS = ['15m', '30m', '1h', '4h', '12h'] as const;

export const SETTINGS_SCHEMA = z
  .object({
    llmProvider: z.enum(LLM_PROVIDERS),
    llmModel: z.string().min(1),
    klineInterval: z.enum(KLINE_INTERVALS),
    loopIntervalMinutes: z.coerce.number().min(1),
    sizingMode: z.enum(['fixed', 'risk', 'atr']),
    amountUsd: z.coerce.number().positive().max(MAX_TRADE_AMOUNT_USD),
    riskPctPerTrade: z.coerce.number().min(0.1).max(5),
    atrMultiplier: z.coerce.number().min(0.5).max(10),
    accountEquityUsd: z.coerce.number().positive(),
    minConfidence: z.coerce.number().min(0).max(100),
    minRrRatio: z.coerce.number().min(1),
    cooldownMinutes: z.coerce.number().min(0),
    symbols: z.string().min(1),
    maxDailyLossPct: z.coerce.number().min(0).max(100),
    maxDailyLosses: z.coerce.number().int().min(1),
    maxPortfolioHeatPct: z.coerce.number().min(0).max(50),
  })
  .partial();

export type Settings = z.infer<typeof SETTINGS_SCHEMA>;

export class SettingsValidationError extends Error {
  fieldErrors: Record<string, string>;
  constructor(issues: z.ZodIssue[]) {
    super('settings validation failed');
    this.name = 'SettingsValidationError';
    this.fieldErrors = {};
    for (const i of issues) this.fieldErrors[i.path.join('.')] = i.message;
  }
}

function settingsPath(): string {
  return process.env.SETTINGS_PATH || path.resolve('./data/settings.json');
}

export function readSettings(): Settings {
  const p = settingsPath();
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = SETTINGS_SCHEMA.safeParse(JSON.parse(fs.readFileSync(p, 'utf8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeSettings(partial: unknown): Settings {
  // zod strips unrecognized keys by default, so secrets/unknown fields drop out.
  const parsed = SETTINGS_SCHEMA.safeParse(partial);
  if (!parsed.success) throw new SettingsValidationError(parsed.error.issues);
  const merged = { ...readSettings(), ...parsed.data };
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(merged, null, 2));
  return merged;
}

const MODEL_ENV: Record<(typeof LLM_PROVIDERS)[number], string> = {
  anthropic: 'CLAUDE_MODEL',
  openai: 'OPENAI_MODEL',
  gemini: 'GEMINI_MODEL',
  deepseek: 'DEEPSEEK_MODEL',
};

export function settingsToEnv(s: Settings): Record<string, string> {
  const env: Record<string, string> = {};
  if (s.llmProvider) env.LLM_PROVIDER = s.llmProvider;
  if (s.llmModel && s.llmProvider) env[MODEL_ENV[s.llmProvider]] = s.llmModel;
  if (s.klineInterval) env.KLINE_INTERVAL = s.klineInterval;
  if (s.loopIntervalMinutes != null) env.LOOP_INTERVAL_MINUTES = String(s.loopIntervalMinutes);
  if (s.sizingMode) env.SIZING_MODE = s.sizingMode;
  if (s.amountUsd != null) env.TRADE_AMOUNT_USD = String(s.amountUsd);
  if (s.riskPctPerTrade != null) env.RISK_PCT_PER_TRADE = String(s.riskPctPerTrade);
  if (s.atrMultiplier != null) env.ATR_MULTIPLIER = String(s.atrMultiplier);
  if (s.accountEquityUsd != null) env.ACCOUNT_EQUITY_USD = String(s.accountEquityUsd);
  if (s.minConfidence != null) env.MIN_CONFIDENCE = String(s.minConfidence);
  if (s.minRrRatio != null) env.MIN_RR_RATIO = String(s.minRrRatio);
  if (s.cooldownMinutes != null) env.COOLDOWN_MINUTES = String(s.cooldownMinutes);
  if (s.symbols) env.SYMBOLS = s.symbols;
  if (s.maxDailyLossPct != null) env.MAX_DAILY_LOSS_PCT = String(s.maxDailyLossPct);
  if (s.maxDailyLosses != null) env.MAX_DAILY_LOSSES = String(s.maxDailyLosses);
  if (s.maxPortfolioHeatPct != null) env.MAX_PORTFOLIO_HEAT_PCT = String(s.maxPortfolioHeatPct);
  return env;
}
