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

const ConfigSchema = z.object({
  binance: z.object({
    apiKey: z.string().default(''),
    apiSecret: z.string().default(''),
  }),
  anthropic: z.object({
    apiKey: z.string().default(''),
    model: z.string().default('claude-opus-4-7'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  }),
  trading: z.object({
    mode: z.enum(['dryrun', 'live', 'backtest']).default('dryrun'),
    amountUsd: z.coerce.number().positive().max(MAX_TRADE_AMOUNT_USD).default(50),
    minConfidence: z.coerce.number().min(0).max(100).default(70),
    minRrRatio: z.coerce.number().min(1).default(2),
    cooldownMinutes: z.coerce.number().min(0).default(30),
    symbols: csvList.default('BTCUSDT,ETHUSDT,SOLUSDT'),
    loopIntervalMinutes: z.coerce.number().min(1).default(15),
    understandRisks: boolFromYesNo.default('no'),
  }),
  storage: z.object({
    dbPath: z.string().default('./data/trade.db'),
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
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      model: process.env.CLAUDE_MODEL,
      effort: process.env.CLAUDE_EFFORT,
    },
    trading: {
      mode: process.env.TRADE_MODE,
      amountUsd: process.env.TRADE_AMOUNT_USD,
      minConfidence: process.env.MIN_CONFIDENCE,
      minRrRatio: process.env.MIN_RR_RATIO,
      cooldownMinutes: process.env.COOLDOWN_MINUTES,
      symbols: process.env.SYMBOLS,
      loopIntervalMinutes: process.env.LOOP_INTERVAL_MINUTES,
      understandRisks: process.env.I_UNDERSTAND_RISKS,
    },
    storage: {
      dbPath: process.env.DB_PATH,
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
