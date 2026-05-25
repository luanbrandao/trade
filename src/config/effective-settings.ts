import { config } from './config';
import { readSettings, LLM_PROVIDERS } from './settings-store';

export interface EffectiveSettings {
  llmProvider: string;
  llmModel: string;
  klineInterval: string;
  loopIntervalMinutes: number;
  sizingMode: string;
  amountUsd: number;
  riskPctPerTrade: number;
  atrMultiplier: number;
  accountEquityUsd: number;
  minConfidence: number;
  minRrRatio: number;
  cooldownMinutes: number;
  symbols: string;
  maxDailyLossPct: number;
  maxDailyLosses: number;
  maxPortfolioHeatPct: number;
}

export function effectiveSettings(): EffectiveSettings {
  const s = readSettings();
  const provider = (s.llmProvider ?? config.llm.provider) as (typeof LLM_PROVIDERS)[number];
  const model = s.llmModel ?? config[provider].model;
  const t = config.trading;
  return {
    llmProvider: provider,
    llmModel: model,
    klineInterval: s.klineInterval ?? t.klineInterval,
    loopIntervalMinutes: s.loopIntervalMinutes ?? t.loopIntervalMinutes,
    sizingMode: s.sizingMode ?? t.sizingMode,
    amountUsd: s.amountUsd ?? t.amountUsd,
    riskPctPerTrade: s.riskPctPerTrade ?? t.riskPctPerTrade,
    atrMultiplier: s.atrMultiplier ?? t.atrMultiplier,
    accountEquityUsd: s.accountEquityUsd ?? t.accountEquityUsd,
    minConfidence: s.minConfidence ?? t.minConfidence,
    minRrRatio: s.minRrRatio ?? t.minRrRatio,
    cooldownMinutes: s.cooldownMinutes ?? t.cooldownMinutes,
    symbols: s.symbols ?? t.symbols.join(','),
    maxDailyLossPct: s.maxDailyLossPct ?? t.maxDailyLossPct,
    maxDailyLosses: s.maxDailyLosses ?? t.maxDailyLosses,
    maxPortfolioHeatPct: s.maxPortfolioHeatPct ?? t.maxPortfolioHeatPct,
  };
}

export function keyedProviders(): string[] {
  return LLM_PROVIDERS.filter((p) => config[p].apiKey !== '');
}
