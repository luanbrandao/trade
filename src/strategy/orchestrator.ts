import { BinancePublicClient } from '../binance/public-client';
import { BinancePrivateClient } from '../binance/private-client';
import { LlmDecider } from '../llm/types';
import { createLlmDecider } from '../llm/factory';
import { PromptContext } from '../llm/prompt';
import { TradeExecutor, ExecutionMode, ExecutionResult } from '../executor/trade-executor';
import { fetchSnapshot, emaPreFilter } from './market-data';
import { config } from '../config/config';
import { insertDecision, markDecisionExecuted, markDecisionSkipped } from '../storage/decisions';
import { isInCooldown, remainingCooldownMinutes, setCooldown } from '../storage/cooldowns';
import { getOpenTrades, TradeRecord } from '../storage/trades';
import { TradeCloser, CloserResult } from '../postmortem/closer';
import { FillSimulator } from '../paper/fill-simulator';
import { checkDailyGate } from '../paper/daily-gate';
import { log } from '../logger';
import { detectRegime, RegimeSnapshot } from './regime';
import { effectiveMinConfidence, maxPositionsForRegime } from './regime-policy';
import { getPerformanceSummary } from '../stats/performance-summary';

export interface SymbolResult {
  symbol: string;
  outcome:
    | 'SKIPPED_COOLDOWN'
    | 'SKIPPED_OPEN_POSITION'
    | 'SKIPPED_POSITION_LIMIT'
    | 'SKIPPED_EMA'
    | 'SKIPPED_DECISION'
    | 'SKIPPED_DAILY_GATE'
    | 'EXECUTED'
    | 'ERROR';
  decisionId?: number;
  executionResult?: ExecutionResult;
  reason?: string;
  costUsd?: number;
}

export class Orchestrator {
  private pub: BinancePublicClient;
  private priv: BinancePrivateClient | null;
  private claude: LlmDecider;
  private executor: TradeExecutor;
  private closer: TradeCloser;
  private fillSim: FillSimulator;
  private mode: ExecutionMode;

  constructor(mode: ExecutionMode) {
    this.pub = new BinancePublicClient();
    this.priv =
      mode === 'live'
        ? new BinancePrivateClient(config.binance.apiKey, config.binance.apiSecret)
        : null;
    this.claude = createLlmDecider();
    this.executor = new TradeExecutor(this.priv);
    this.closer = new TradeCloser(this.pub, this.priv);
    this.fillSim = new FillSimulator(this.pub, this.closer);
    this.mode = mode;
  }

  async closeMatured(): Promise<CloserResult> {
    if (this.mode === 'live') {
      return this.closer.runLive();
    }
    return this.fillSim.runDryrunFillSim();
  }

  async runSymbol(symbol: string): Promise<SymbolResult> {
    if (this.mode === 'dryrun') {
      const gate = checkDailyGate();
      if (!gate.allowed) {
        return {
          symbol,
          outcome: 'SKIPPED_DAILY_GATE',
          reason: gate.reason,
        };
      }
    }

    if (isInCooldown(symbol, config.trading.cooldownMinutes)) {
      const remaining = remainingCooldownMinutes(symbol, config.trading.cooldownMinutes);
      return {
        symbol,
        outcome: 'SKIPPED_COOLDOWN',
        reason: `cooldown active, ${remaining.toFixed(1)} min remaining`,
      };
    }

    const openTrades = getOpenTrades(symbol);
    const hasOpenPosition = openTrades.length > 0;

    // One position per symbol: never stack a second trade on the same crypto.
    // With manageOpenPositions on, the LLM re-evaluates the position and may
    // SELL to exit early; otherwise exits are bracket/timeout only.
    if (hasOpenPosition) {
      if (!config.trading.manageOpenPositions) {
        return {
          symbol,
          outcome: 'SKIPPED_OPEN_POSITION',
          reason: `already has an open ${symbol} position`,
        };
      }
      return this.manageOpenPosition(symbol, openTrades);
    }

    // Regime first (15-min cache, one real fetch per cycle): it gates the
    // position limit and confidence floor before any per-symbol cost.
    let regime: RegimeSnapshot | undefined;
    try {
      regime = await detectRegime(this.pub);
    } catch (err: any) {
      log.warn('Regime fetch failed', { err: err.message });
    }

    // BTC/ETH/SOL are heavily correlated — heat cap alone treats them as
    // independent bets, so cap concurrent positions harder in bad regimes.
    const allOpen = getOpenTrades().filter((t) => t.mode === this.mode);
    const positionLimit = maxPositionsForRegime(config.trading.maxOpenPositions, regime?.regime);
    if (allOpen.length >= positionLimit) {
      return {
        symbol,
        outcome: 'SKIPPED_POSITION_LIMIT',
        reason: `${allOpen.length} open positions >= limit ${positionLimit} (regime ${regime?.regime ?? 'n/a'})`,
      };
    }

    let snapshot;
    try {
      snapshot = await fetchSnapshot(this.pub, symbol);
    } catch (err: any) {
      return { symbol, outcome: 'ERROR', reason: `fetchSnapshot failed: ${err.message}` };
    }

    const preFilter = emaPreFilter(snapshot, hasOpenPosition);
    if (preFilter === 'SKIP') {
      return {
        symbol,
        outcome: 'SKIPPED_EMA',
        reason: `EMA filter: trend=${snapshot.ema.trend} cross=${snapshot.ema.cross}`,
      };
    }

    const minConfidence = effectiveMinConfidence(config.trading.minConfidence, regime?.regime);

    let performance = null;
    try {
      performance = getPerformanceSummary(this.mode === 'live' ? 'live' : 'dryrun');
    } catch (err: any) {
      log.warn('Performance summary failed', { err: err.message });
    }

    const ctx: PromptContext = {
      minConfidence,
      minRrRatio: config.trading.minRrRatio,
      cooldownMinutes: config.trading.cooldownMinutes,
      amountUsd: config.trading.amountUsd,
      hasOpenPosition,
      regime,
      performance,
    };

    let llmResult;
    try {
      llmResult = await this.claude.decide(snapshot, ctx);
    } catch (err: any) {
      return { symbol, outcome: 'ERROR', reason: `LLM failed: ${err.message}` };
    }

    const decisionId = insertDecision({
      ts: Date.now(),
      symbol,
      action: llmResult.decision.action,
      confidence: llmResult.decision.confidence,
      reason: llmResult.decision.reason,
      stopLossPct: llmResult.decision.stopLossPercent,
      takeProfitPct: llmResult.decision.takeProfitPercent,
      timeHorizonMinutes: llmResult.decision.timeHorizonMinutes,
      priceAtDecision: snapshot.currentPrice,
      llmModel: llmResult.model,
      llmInputTokens: llmResult.usage.inputTokens,
      llmOutputTokens: llmResult.usage.outputTokens,
      llmCostUsd: llmResult.usage.costUsd,
      executed: false,
      skipReason: null,
      mode: this.mode,
      strategyName: config.trading.strategyName,
    });

    if (llmResult.decision.action === 'HOLD') {
      markDecisionSkipped(decisionId, 'HOLD');
      return {
        symbol,
        outcome: 'SKIPPED_DECISION',
        decisionId,
        reason: `HOLD (confidence ${llmResult.decision.confidence}%)`,
        costUsd: llmResult.usage.costUsd,
      };
    }

    if (llmResult.decision.confidence < minConfidence) {
      markDecisionSkipped(decisionId, `confidence ${llmResult.decision.confidence} < ${minConfidence} (regime-adjusted)`);
      return {
        symbol,
        outcome: 'SKIPPED_DECISION',
        decisionId,
        reason: `confidence ${llmResult.decision.confidence}% < ${minConfidence}% (regime ${regime?.regime ?? 'n/a'})`,
        costUsd: llmResult.usage.costUsd,
      };
    }

    const execResult = await this.executor.execute({
      symbol,
      decision: llmResult.decision,
      decisionId,
      currentPrice: snapshot.currentPrice,
      minRrRatio: config.trading.minRrRatio,
      mode: this.mode,
      atrAbsolute: snapshot.atr ?? undefined,
    });

    if (execResult.status === 'EXECUTED') {
      markDecisionExecuted(decisionId);
      return {
        symbol,
        outcome: 'EXECUTED',
        decisionId,
        executionResult: execResult,
        costUsd: llmResult.usage.costUsd,
      };
    }

    markDecisionSkipped(decisionId, execResult.reason ?? execResult.status);
    return {
      symbol,
      outcome: execResult.status === 'ERROR' ? 'ERROR' : 'SKIPPED_DECISION',
      decisionId,
      executionResult: execResult,
      reason: execResult.reason,
      costUsd: llmResult.usage.costUsd,
    };
  }

  /**
   * Re-evaluate an open position: the LLM sees the fresh snapshot with
   * hasOpenPosition=true and may SELL to close early (trend breakdown,
   * thesis invalidated) instead of waiting for the bracket or timeout.
   * Exits use the BASE confidence floor — a hostile regime should make it
   * harder to enter, never harder to get out.
   */
  private async manageOpenPosition(
    symbol: string,
    openTrades: ReturnType<typeof getOpenTrades>,
  ): Promise<SymbolResult> {
    let snapshot;
    try {
      snapshot = await fetchSnapshot(this.pub, symbol);
    } catch (err: any) {
      return { symbol, outcome: 'ERROR', reason: `fetchSnapshot failed: ${err.message}` };
    }

    let regime: RegimeSnapshot | undefined;
    try {
      regime = await detectRegime(this.pub);
    } catch (err: any) {
      log.warn('Regime fetch failed', { err: err.message });
    }

    let performance = null;
    try {
      performance = getPerformanceSummary(this.mode === 'live' ? 'live' : 'dryrun');
    } catch (err: any) {
      log.warn('Performance summary failed', { err: err.message });
    }

    const minConfidence = config.trading.minConfidence;
    const ctx: PromptContext = {
      minConfidence,
      minRrRatio: config.trading.minRrRatio,
      cooldownMinutes: config.trading.cooldownMinutes,
      amountUsd: config.trading.amountUsd,
      hasOpenPosition: true,
      regime,
      performance,
    };

    let llmResult;
    try {
      llmResult = await this.claude.decide(snapshot, ctx);
    } catch (err: any) {
      return { symbol, outcome: 'ERROR', reason: `LLM failed: ${err.message}` };
    }

    const decisionId = insertDecision({
      ts: Date.now(),
      symbol,
      action: llmResult.decision.action,
      confidence: llmResult.decision.confidence,
      reason: llmResult.decision.reason,
      stopLossPct: llmResult.decision.stopLossPercent,
      takeProfitPct: llmResult.decision.takeProfitPercent,
      timeHorizonMinutes: llmResult.decision.timeHorizonMinutes,
      priceAtDecision: snapshot.currentPrice,
      llmModel: llmResult.model,
      llmInputTokens: llmResult.usage.inputTokens,
      llmOutputTokens: llmResult.usage.outputTokens,
      llmCostUsd: llmResult.usage.costUsd,
      executed: false,
      skipReason: null,
      mode: this.mode,
      strategyName: config.trading.strategyName,
    });

    if (llmResult.decision.action === 'BUY') {
      markDecisionSkipped(decisionId, 'BUY blocked (open position)');
      return {
        symbol,
        outcome: 'SKIPPED_DECISION',
        decisionId,
        reason: 'BUY blocked while position open',
        costUsd: llmResult.usage.costUsd,
      };
    }

    if (llmResult.decision.action === 'HOLD') {
      markDecisionSkipped(decisionId, 'HOLD (position open)');
      return {
        symbol,
        outcome: 'SKIPPED_DECISION',
        decisionId,
        reason: `HOLD position (confidence ${llmResult.decision.confidence}%)`,
        costUsd: llmResult.usage.costUsd,
      };
    }

    if (llmResult.decision.confidence < minConfidence) {
      markDecisionSkipped(
        decisionId,
        `SELL confidence ${llmResult.decision.confidence} < ${minConfidence}`,
      );
      return {
        symbol,
        outcome: 'SKIPPED_DECISION',
        decisionId,
        reason: `SELL confidence ${llmResult.decision.confidence}% < ${minConfidence}%`,
        costUsd: llmResult.usage.costUsd,
      };
    }

    try {
      for (const trade of openTrades) {
        await this.closePosition(trade, snapshot.currentPrice);
      }
    } catch (err: any) {
      markDecisionSkipped(decisionId, `close failed: ${err.message}`);
      return {
        symbol,
        outcome: 'ERROR',
        decisionId,
        reason: `position close failed: ${err.message}`,
        costUsd: llmResult.usage.costUsd,
      };
    }

    markDecisionExecuted(decisionId);
    setCooldown(symbol);
    log.info('Position closed by LLM SELL', {
      symbol,
      confidence: llmResult.decision.confidence,
      reason: llmResult.decision.reason.slice(0, 120),
    });
    return {
      symbol,
      outcome: 'EXECUTED',
      decisionId,
      reason: `SELL closed position (confidence ${llmResult.decision.confidence}%)`,
      costUsd: llmResult.usage.costUsd,
    };
  }

  private async closePosition(trade: TradeRecord, currentPrice: number): Promise<void> {
    if (this.mode !== 'live') {
      await this.closer.persistClose(trade, currentPrice, Date.now(), 'MANUAL', 'LLM_EARLY_EXIT');
      return;
    }

    if (!this.priv) throw new Error('live close requires private client');

    // The bracket must die before the market exit, or the OCO leg would
    // double-sell the same quantity.
    try {
      await this.priv.cancelOpenOrders(trade.symbol);
    } catch (err: any) {
      const msg = err.response?.data?.msg ?? err.message;
      // -2011 = nothing to cancel (bracket may already be gone)
      if (!String(msg).includes('Unknown order')) {
        log.warn('cancelOpenOrders failed before early exit', { symbol: trade.symbol, msg });
      }
    }

    const filters = await this.priv.getSymbolFilters(trade.symbol);
    const step = filters.stepSize || 0.0001;
    const qty = Math.floor(trade.qty / step) * step;
    const order = await this.priv.createMarketOrderByQty(trade.symbol, 'SELL', qty);

    const executedQty = parseFloat(order.executedQty);
    const exitPrice =
      executedQty > 0 ? parseFloat(order.cummulativeQuoteQty) / executedQty : currentPrice;
    await this.closer.persistClose(trade, exitPrice, Date.now(), 'MANUAL', 'LLM_EARLY_EXIT');
  }

  async runAll(symbols: string[]): Promise<SymbolResult[]> {
    const results: SymbolResult[] = [];
    for (const sym of symbols) {
      results.push(await this.runSymbol(sym));
    }
    return results;
  }
}
