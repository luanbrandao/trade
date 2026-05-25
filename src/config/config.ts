import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const MAX_TRADE_AMOUNT_USD = 200;

const csvList = z
  .string()
  .min(1)
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

const boolFromYesNo = z
  .enum(['yes', 'no'])
  .transform((v) => v === 'yes');

const boolFromFlag = z
  .string()
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()));

const ConfigSchema = z.object({
  binance: z.object({
    apiKey: z.string().default(''),
    apiSecret: z.string().default(''),
  }),
  llm: z.object({
    provider: z.enum(['anthropic', 'openai', 'gemini', 'deepseek']).default('anthropic'),
  }),
  anthropic: z.object({
    apiKey: z.string().default(''),
    model: z.string().default('claude-opus-4-7'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  }),
  openai: z.object({
    apiKey: z.string().default(''),
    model: z.string().default('gpt-4o-mini'),
  }),
  gemini: z.object({
    apiKey: z.string().default(''),
    model: z.string().default('gemini-2.5-flash'),
  }),
  deepseek: z.object({
    apiKey: z.string().default(''),
    model: z.string().default('deepseek-chat'),
    baseUrl: z.string().default('https://api.deepseek.com/v1'),
  }),
  trading: z.object({
    mode: z.enum(['dryrun', 'live', 'backtest']).default('dryrun'),
    amountUsd: z.coerce.number().positive().max(MAX_TRADE_AMOUNT_USD).default(50),
    sizingMode: z.enum(['fixed', 'risk', 'atr']).default('fixed'),
    riskPctPerTrade: z.coerce.number().min(0.1).max(5).default(1),
    accountEquityUsd: z.coerce.number().positive().default(1000),
    atrMultiplier: z.coerce.number().min(0.5).max(10).default(2),
    maxPortfolioHeatPct: z.coerce.number().min(0).max(50).default(6),
    minConfidence: z.coerce.number().min(0).max(100).default(70),
    minRrRatio: z.coerce.number().min(1).default(2),
    cooldownMinutes: z.coerce.number().min(0).default(30),
    symbols: csvList.default('BTCUSDT,ETHUSDT,SOLUSDT'),
    loopIntervalMinutes: z.coerce.number().min(1).default(15),
    understandRisks: boolFromYesNo.default('no'),
    strategyName: z.string().min(1).default('ema9_21+claude_v1'),
    maxDailyLossPct: z.coerce.number().min(0).max(100).default(3.0),
    maxDailyLosses: z.coerce.number().int().min(1).default(3),
    dryrunMaxHoldHours: z.coerce.number().min(1).default(168),
  }),
  storage: z.object({
    dbPath: z.string().default('./data/trade.db'),
  }),
  dashboard: z.object({
    port: z.coerce.number().int().min(1).max(65535).default(8787),
    host: z.string().default('0.0.0.0'),
    pathPrefix: z.string().default(''),
    autostartLoop: boolFromFlag.default('false'),
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }),
  notify: z.object({
    discordWebhookUrl: z.string().default(''),
    telegramBotToken: z.string().default(''),
    telegramChatId: z.string().default(''),
    on: z
      .string()
      .default('executed,error')
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim().toLowerCase())
          .filter((x): x is NotifyEvent => ['executed', 'error', 'summary', 'skipped'].includes(x)),
      ),
  }),
});

export type NotifyEvent = 'executed' | 'error' | 'summary' | 'skipped';

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const raw = {
    binance: {
      apiKey: process.env.BINANCE_API_KEY ?? '',
      apiSecret: process.env.BINANCE_API_SECRET ?? '',
    },
    llm: {
      provider: process.env.LLM_PROVIDER,
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      model: process.env.CLAUDE_MODEL,
      effort: process.env.CLAUDE_EFFORT,
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY ?? '',
      model: process.env.OPENAI_MODEL,
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY ?? '',
      model: process.env.GEMINI_MODEL,
    },
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK ?? '',
      model: process.env.DEEPSEEK_MODEL,
      baseUrl: process.env.DEEPSEEK_BASE_URL,
    },
    trading: {
      mode: process.env.TRADE_MODE,
      amountUsd: process.env.TRADE_AMOUNT_USD,
      sizingMode: process.env.SIZING_MODE,
      riskPctPerTrade: process.env.RISK_PCT_PER_TRADE,
      accountEquityUsd: process.env.ACCOUNT_EQUITY_USD,
      atrMultiplier: process.env.ATR_MULTIPLIER,
      maxPortfolioHeatPct: process.env.MAX_PORTFOLIO_HEAT_PCT,
      minConfidence: process.env.MIN_CONFIDENCE,
      minRrRatio: process.env.MIN_RR_RATIO,
      cooldownMinutes: process.env.COOLDOWN_MINUTES,
      symbols: process.env.SYMBOLS,
      loopIntervalMinutes: process.env.LOOP_INTERVAL_MINUTES,
      understandRisks: process.env.I_UNDERSTAND_RISKS,
      strategyName: process.env.STRATEGY_NAME,
      maxDailyLossPct: process.env.MAX_DAILY_LOSS_PCT,
      maxDailyLosses: process.env.MAX_DAILY_LOSSES,
      dryrunMaxHoldHours: process.env.DRYRUN_MAX_HOLD_HOURS,
    },
    storage: {
      dbPath: process.env.DB_PATH,
    },
    dashboard: {
      port: process.env.DASHBOARD_PORT,
      host: process.env.DASHBOARD_HOST,
      pathPrefix: process.env.DASHBOARD_PATH_PREFIX,
      autostartLoop: process.env.DASHBOARD_AUTOSTART_LOOP,
    },
    logging: {
      level: process.env.LOG_LEVEL,
    },
    notify: {
      discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
      telegramChatId: process.env.TELEGRAM_CHAT_ID,
      on: process.env.NOTIFY_ON,
    },
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('Invalid config:');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  const cfg = parsed.data;

  if (cfg.trading.mode === 'live' && !cfg.trading.understandRisks) {
    console.error('Live mode requires I_UNDERSTAND_RISKS=yes in .env');
    process.exit(1);
  }

  return cfg;
}

export const config = loadConfig();
export { MAX_TRADE_AMOUNT_USD };
