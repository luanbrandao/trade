import { Command } from 'commander';
import { config } from './config/config';
import { TradingLoop, runOnce } from './loop';
import { log } from './logger';
import { getOpenTrades, getPnlSummary } from './storage/trades';
import { getRecentDecisions } from './storage/decisions';
import { getRecentPostmortems } from './storage/postmortems';
import { closeDb } from './storage/db';
import { BinancePublicClient } from './binance/public-client';
import { BinancePrivateClient } from './binance/private-client';
import { TradeCloser } from './postmortem/closer';
import { FillSimulator } from './paper/fill-simulator';
import { runBacktest, LlmMode } from './backtest/engine';
import { computeMetrics, formatMetrics } from './backtest/metrics';
import { KlineInterval } from './binance/public-client';

const program = new Command();

program
  .name('trade')
  .description('Spot trading bot — Claude + Binance')
  .version('0.1.0');

program
  .command('dryrun')
  .description('Run strategy loop in dryrun mode (no real orders)')
  .option('--symbols <list>', 'Comma-separated symbols (override .env)', '')
  .option('--interval <minutes>', 'Loop interval in minutes (override .env)', '')
  .action((opts) => {
    const symbols = opts.symbols ? opts.symbols.split(',') : config.trading.symbols;
    const interval = opts.interval ? parseInt(opts.interval, 10) : config.trading.loopIntervalMinutes;
    const loop = new TradingLoop({ mode: 'dryrun', symbols, intervalMinutes: interval });
    loop.start();
  });

program
  .command('live')
  .description('Run strategy loop in LIVE mode (REAL ORDERS — requires I_UNDERSTAND_RISKS=yes)')
  .option('--symbols <list>', 'Comma-separated symbols (override .env)', '')
  .option('--interval <minutes>', 'Loop interval in minutes (override .env)', '')
  .action((opts) => {
    if (!config.trading.understandRisks) {
      log.error('Live mode requires I_UNDERSTAND_RISKS=yes in .env');
      process.exit(1);
    }
    const symbols = opts.symbols ? opts.symbols.split(',') : config.trading.symbols;
    const interval = opts.interval ? parseInt(opts.interval, 10) : config.trading.loopIntervalMinutes;
    log.warn('LIVE MODE — real orders will be placed', {
      symbols: symbols.join(','),
      amountUsd: config.trading.amountUsd,
    });
    const loop = new TradingLoop({ mode: 'live', symbols, intervalMinutes: interval });
    loop.start();
  });

program
  .command('once')
  .description('Run a single cycle then exit (useful for cron)')
  .option('--mode <mode>', 'dryrun | live', 'dryrun')
  .option('--symbols <list>', 'Comma-separated symbols (override .env)', '')
  .action(async (opts) => {
    if (opts.mode !== 'dryrun' && opts.mode !== 'live') {
      log.error('Invalid mode', { mode: opts.mode });
      process.exit(1);
    }
    if (opts.mode === 'live' && !config.trading.understandRisks) {
      log.error('Live mode requires I_UNDERSTAND_RISKS=yes in .env');
      process.exit(1);
    }
    const symbols = opts.symbols ? opts.symbols.split(',') : config.trading.symbols;
    try {
      await runOnce(opts.mode as 'dryrun' | 'live', symbols);
      process.exit(0);
    } catch (err: any) {
      log.error('Run failed', { err: err.message });
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show open trades + PnL summary from local SQLite')
  .option('--mode <mode>', 'Filter by mode: dryrun | live | backtest', '')
  .option('--decisions <n>', 'Show last N decisions', '10')
  .action((opts) => {
    const mode = opts.mode || undefined;
    const decisionLimit = parseInt(opts.decisions, 10) || 10;

    console.log('\n=== Open Trades ===');
    const open = getOpenTrades();
    if (open.length === 0) {
      console.log('  (none)');
    } else {
      for (const t of open) {
        console.log(
          `  #${t.id} ${t.symbol} ${t.side} qty=${t.qty} @ ${t.avgPrice} TP=${t.tpPrice} SL=${t.slPrice} mode=${t.mode}`,
        );
      }
    }

    console.log('\n=== PnL Summary ===');
    const pnl = getPnlSummary(mode as 'dryrun' | 'live' | 'backtest' | undefined);
    console.log(`  Closed trades: ${pnl.trades}`);
    console.log(`  Win rate: ${(pnl.winRate * 100).toFixed(1)}% (${pnl.wins}W / ${pnl.losses}L)`);
    console.log(`  Total PnL: ${pnl.totalPnlQuote.toFixed(2)} USDT`);
    console.log(`  Avg PnL %: ${pnl.avgPnlPct.toFixed(2)}%`);

    console.log(`\n=== Recent Decisions (last ${decisionLimit}) ===`);
    const decisions = getRecentDecisions(decisionLimit);
    for (const d of decisions) {
      const ts = new Date((d as any).ts).toISOString().slice(0, 19).replace('T', ' ');
      console.log(
        `  [${ts}] ${(d as any).symbol} ${(d as any).action} conf=${(d as any).confidence}% ${(d as any).executed ? 'EXEC' : 'SKIP'} ${(d as any).skip_reason ?? ''}`,
      );
    }

    console.log('\n=== Recent Postmortems (last 10) ===');
    const pms = getRecentPostmortems(10);
    if (pms.length === 0) console.log('  (none)');
    for (const p of pms) {
      const ts = new Date((p as any).closed_ts).toISOString().slice(0, 19).replace('T', ' ');
      console.log(
        `  [${ts}] trade=${(p as any).trade_id} ${(p as any).outcome} pnl=${(p as any).pnl_pct?.toFixed(2)}% hold=${(p as any).holding_minutes?.toFixed(0)}min MAE=${(p as any).mae_pct?.toFixed(2) ?? '-'} MFE=${(p as any).mfe_pct?.toFixed(2) ?? '-'} class=${(p as any).classification}`,
      );
    }

    closeDb();
  });

program
  .command('close-trades')
  .description('Run postmortem closer once: detect filled OCOs, close trades, record outcomes')
  .option('--mode <mode>', 'live | dryrun', 'live')
  .option('--max-age-hours <n>', 'For dryrun: close trades older than N hours', '48')
  .action(async (opts) => {
    if (opts.mode !== 'live' && opts.mode !== 'dryrun') {
      log.error('Invalid --mode', { mode: opts.mode });
      process.exit(1);
    }
    const pub = new BinancePublicClient();
    const priv =
      opts.mode === 'live'
        ? new BinancePrivateClient(config.binance.apiKey, config.binance.apiSecret)
        : null;
    const closer = new TradeCloser(pub, priv);
    const fillSim = new FillSimulator(pub, closer);
    const result =
      opts.mode === 'live' ? await closer.runLive() : await fillSim.runDryrunFillSim();
    log.info('Closer done', { checked: result.checked, closed: result.closed, errors: result.errors });
    closeDb();
    process.exit(0);
  });

program
  .command('monitor')
  .description('Watch open trades + PnL, refreshing every N seconds')
  .option('--interval <seconds>', 'Refresh interval', '5')
  .option('--mode <mode>', 'Filter PnL by mode: dryrun | live | backtest', '')
  .action(async (opts) => {
    const intervalSec = Math.max(1, parseInt(opts.interval, 10) || 5);
    const mode = opts.mode || undefined;

    const render = () => {
      process.stdout.write('\x1b[2J\x1b[H');
      console.log(`trade monitor — refresh ${intervalSec}s  (Ctrl+C to exit)`);
      console.log(`time: ${new Date().toISOString()}`);
      console.log();

      const open = getOpenTrades();
      console.log(`Open trades: ${open.length}`);
      for (const t of open) {
        console.log(
          `  #${t.id} ${t.symbol} ${t.side} qty=${t.qty} @ ${t.avgPrice} TP=${t.tpPrice} SL=${t.slPrice} (${t.mode})`,
        );
      }

      const pnl = getPnlSummary(mode as 'dryrun' | 'live' | 'backtest' | undefined);
      console.log();
      console.log(`PnL (${mode ?? 'all modes'}): ${pnl.trades} closed  WR ${(pnl.winRate * 100).toFixed(1)}%  total ${pnl.totalPnlQuote.toFixed(2)} USDT  avg ${pnl.avgPnlPct.toFixed(2)}%`);

      const recent = getRecentDecisions(5);
      console.log();
      console.log('Recent decisions:');
      for (const d of recent) {
        const ts = new Date((d as any).ts).toISOString().slice(11, 19);
        console.log(
          `  ${ts}  ${(d as any).symbol}  ${(d as any).action}  conf=${(d as any).confidence}%  ${(d as any).executed ? 'EXEC' : 'SKIP'}`,
        );
      }
    };

    render();
    const timer = setInterval(render, intervalSec * 1000);
    process.once('SIGINT', () => {
      clearInterval(timer);
      closeDb();
      process.exit(0);
    });
  });

program
  .command('backtest')
  .description('Replay historical klines through the strategy')
  .requiredOption('--symbol <symbol>', 'e.g. BTCUSDT')
  .requiredOption('--from <date>', 'YYYY-MM-DD')
  .requiredOption('--to <date>', 'YYYY-MM-DD')
  .option('--llm <mode>', 'mock | claude (claude is expensive)', 'mock')
  .option('--interval <interval>', '1m|5m|15m|1h|4h|1d', '1h')
  .option('--ema-fast <n>', 'fast EMA period', '9')
  .option('--ema-slow <n>', 'slow EMA period', '21')
  .option('--warmup <n>', 'warmup candles before trading', '50')
  .option('--slippage <pct>', 'per-side slippage % (entry + exit). Recommend 0.05-0.1', '0.05')
  .option('--fee <pct>', 'exchange fee % per side (Binance spot taker = 0.1)', '0.1')
  .option('--manage-positions', 're-evaluate open positions each candle, allow early exits (mirrors live; expensive with --llm claude)', false)
  .action(async (opts) => {
    if (opts.llm !== 'mock' && opts.llm !== 'claude') {
      log.error('Invalid --llm', { llm: opts.llm });
      process.exit(1);
    }
    const from = new Date(opts.from);
    const to = new Date(opts.to);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      log.error('Invalid date', { from: opts.from, to: opts.to });
      process.exit(1);
    }
    if (from >= to) {
      log.error('--from must be before --to');
      process.exit(1);
    }

    const slippagePct = parseFloat(opts.slippage);
    const feePct = parseFloat(opts.fee);

    try {
      const result = await runBacktest({
        symbol: opts.symbol,
        interval: opts.interval as KlineInterval,
        from,
        to,
        llmMode: opts.llm as LlmMode,
        emaFast: parseInt(opts.emaFast, 10),
        emaSlow: parseInt(opts.emaSlow, 10),
        amountUsd: config.trading.amountUsd,
        minConfidence: config.trading.minConfidence,
        minRrRatio: config.trading.minRrRatio,
        cooldownMinutes: config.trading.cooldownMinutes,
        warmupCandles: parseInt(opts.warmup, 10),
        slippagePct,
        feePct,
        managePositions: Boolean(opts.managePositions),
      });

      const metrics = computeMetrics(result.trades, {
        slippageTested: slippagePct > 0,
        feesTested: feePct > 0,
      });
      console.log(formatMetrics(metrics, result.symbol));
      console.log(`\nCandles processed: ${result.totalCandles}`);
      console.log(`Decisions made: ${result.decisionsTotal}  Executed: ${result.decisionsExecuted}`);
      console.log(`Slippage modeled: ${slippagePct}% per side  Fees: ${feePct}% per side ($${result.totalFeesQuote.toFixed(2)} total)`);
      if (opts.llm === 'claude') {
        console.log(`LLM cost: $${result.totalLlmCostUsd.toFixed(4)}`);
      }
      process.exit(0);
    } catch (err: any) {
      log.error('Backtest failed', { err: err.message });
      process.exit(1);
    }
  });

program
  .command('sweep')
  .description('Run backtest across parameter range — find plateaus, not peaks')
  .requiredOption('--symbol <symbol>', 'e.g. BTCUSDT')
  .requiredOption('--from <date>', 'YYYY-MM-DD')
  .requiredOption('--to <date>', 'YYYY-MM-DD')
  .requiredOption('--param <name>', 'ema-fast | ema-slow | slippage | fee')
  .requiredOption('--values <csv>', 'comma-separated values, e.g. 5,7,9,11,14')
  .option('--llm <mode>', 'mock | claude', 'mock')
  .option('--interval <interval>', '1h|4h|1d', '1h')
  .option('--warmup <n>', 'warmup candles', '50')
  .action(async (opts) => {
    const from = new Date(opts.from);
    const to = new Date(opts.to);
    const values = opts.values.split(',').map((v: string) => parseFloat(v.trim()));
    const llmMode = opts.llm as LlmMode;

    console.log(`Sweep: ${opts.param} = [${values.join(', ')}]  on ${opts.symbol}`);
    console.log('value\ttrades\twin%\tpnl%\tpf\tmdd%\tverdict');

    for (const v of values) {
      const baseOpts = {
        symbol: opts.symbol,
        interval: opts.interval as KlineInterval,
        from,
        to,
        llmMode,
        emaFast: 9,
        emaSlow: 21,
        amountUsd: config.trading.amountUsd,
        minConfidence: config.trading.minConfidence,
        minRrRatio: config.trading.minRrRatio,
        cooldownMinutes: config.trading.cooldownMinutes,
        warmupCandles: parseInt(opts.warmup, 10),
        slippagePct: 0.05,
        feePct: 0.1,
      };

      if (opts.param === 'ema-fast') baseOpts.emaFast = v;
      else if (opts.param === 'ema-slow') baseOpts.emaSlow = v;
      else if (opts.param === 'slippage') baseOpts.slippagePct = v;
      else if (opts.param === 'fee') baseOpts.feePct = v;
      else {
        log.error('Invalid --param', { param: opts.param });
        process.exit(1);
      }

      try {
        const result = await runBacktest(baseOpts);
        const m = computeMetrics(result.trades, {
          slippageTested: baseOpts.slippagePct > 0,
          feesTested: baseOpts.feePct > 0,
        });
        const pf = m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2);
        console.log(
          `${v}\t${m.trades}\t${(m.winRate * 100).toFixed(1)}\t${m.totalPnlPct.toFixed(2)}\t${pf}\t${m.maxDrawdownPct.toFixed(1)}\t${m.verdict.verdict}`,
        );
      } catch (err: any) {
        console.log(`${v}\tERROR: ${err.message}`);
      }
    }
    process.exit(0);
  });

program.parseAsync().catch((err) => {
  log.error('CLI error', { err: err.message });
  process.exit(1);
});
