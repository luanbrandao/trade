import { Orchestrator, SymbolResult } from './strategy/orchestrator';
import { ExecutionMode } from './executor/trade-executor';
import { log } from './logger';
import { closeDb } from './storage/db';
import { Notifier } from './notifier';

export interface LoopOptions {
  mode: ExecutionMode;
  symbols: string[];
  intervalMinutes: number;
}

export class TradingLoop {
  private orch: Orchestrator;
  private opts: LoopOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopRequested = false;
  private cycleCount = 0;
  private notifier: Notifier;

  constructor(opts: LoopOptions) {
    this.opts = opts;
    this.orch = new Orchestrator(opts.mode);
    this.notifier = new Notifier();
  }

  start(): void {
    log.info('Trading loop starting', {
      mode: this.opts.mode,
      symbols: this.opts.symbols.join(','),
      intervalMin: this.opts.intervalMinutes,
    });
    this.scheduleNext(0);
    this.installSignalHandlers();
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopRequested) return;
    this.timer = setTimeout(() => this.runCycle(), delayMs);
  }

  private async runCycle(): Promise<void> {
    if (this.running) {
      log.warn('Previous cycle still running, skipping tick');
      return;
    }

    this.running = true;
    this.cycleCount += 1;
    const cycleStart = Date.now();
    const cycleId = this.cycleCount;

    log.info('Cycle start', { cycle: cycleId });

    try {
      const results = await this.orch.runAll(this.opts.symbols);
      this.logResults(cycleId, results);
    } catch (err: any) {
      log.error('Cycle failed', { cycle: cycleId, err: err.message });
    } finally {
      this.running = false;
      const elapsedMs = Date.now() - cycleStart;
      log.info('Cycle done', { cycle: cycleId, elapsedMs });

      const nextDelayMs = Math.max(0, this.opts.intervalMinutes * 60_000 - elapsedMs);
      this.scheduleNext(nextDelayMs);
    }
  }

  private logResults(cycleId: number, results: SymbolResult[]): void {
    let executed = 0;
    let skipped = 0;
    let errors = 0;
    let totalCost = 0;

    for (const r of results) {
      totalCost += r.costUsd ?? 0;
      if (r.outcome === 'EXECUTED') {
        executed += 1;
        log.info('EXECUTED', {
          cycle: cycleId,
          symbol: r.symbol,
          decisionId: r.decisionId,
          tradeId: r.executionResult?.tradeId,
          orderId: r.executionResult?.binanceOrderId,
        });
        void this.notifier.notify({
          event: 'executed',
          title: `Trade executed — ${r.symbol}`,
          body: `Mode: ${this.opts.mode}`,
          fields: {
            decisionId: r.decisionId ?? '',
            tradeId: r.executionResult?.tradeId ?? '',
            binanceOrderId: r.executionResult?.binanceOrderId ?? '',
            ocoOrderListId: r.executionResult?.ocoOrderListId ?? '',
          },
        });
      } else if (r.outcome === 'ERROR') {
        errors += 1;
        log.error('ERROR', { cycle: cycleId, symbol: r.symbol, reason: r.reason });
        void this.notifier.notify({
          event: 'error',
          title: `Cycle error — ${r.symbol}`,
          body: r.reason ?? 'unknown',
          fields: { cycle: cycleId, mode: this.opts.mode },
        });
      } else {
        skipped += 1;
        log.info('SKIPPED', { cycle: cycleId, symbol: r.symbol, outcome: r.outcome, reason: r.reason });
        void this.notifier.notify({
          event: 'skipped',
          title: `Skipped — ${r.symbol}`,
          body: `${r.outcome}: ${r.reason ?? ''}`,
        });
      }
    }

    log.info('Cycle summary', {
      cycle: cycleId,
      executed,
      skipped,
      errors,
      costUsd: totalCost.toFixed(4),
    });

    void this.notifier.notify({
      event: 'summary',
      title: `Cycle ${cycleId} summary`,
      body: `${this.opts.mode} — ${this.opts.symbols.length} symbols`,
      fields: {
        executed,
        skipped,
        errors,
        costUsd: totalCost.toFixed(4),
      },
    });
  }

  private installSignalHandlers(): void {
    const handler = (sig: string) => {
      log.info('Shutdown signal received', { signal: sig });
      this.stop();
    };
    process.once('SIGINT', () => handler('SIGINT'));
    process.once('SIGTERM', () => handler('SIGTERM'));
  }

  stop(): void {
    this.stopRequested = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      log.info('Waiting for in-flight cycle to complete...');
      const waitInterval = setInterval(() => {
        if (!this.running) {
          clearInterval(waitInterval);
          this.shutdown();
        }
      }, 500);
    } else {
      this.shutdown();
    }
  }

  private shutdown(): void {
    log.info('Trading loop stopped', { totalCycles: this.cycleCount });
    closeDb();
    process.exit(0);
  }
}

export async function runOnce(mode: ExecutionMode, symbols: string[]): Promise<void> {
  log.info('Single-cycle run', { mode, symbols: symbols.join(',') });
  const orch = new Orchestrator(mode);
  const results = await orch.runAll(symbols);

  let totalCost = 0;
  for (const r of results) {
    totalCost += r.costUsd ?? 0;
    log.info(r.outcome, {
      symbol: r.symbol,
      reason: r.reason,
      decisionId: r.decisionId,
      tradeId: r.executionResult?.tradeId,
    });
  }
  log.info('Run done', { totalCostUsd: totalCost.toFixed(4) });
  closeDb();
}
