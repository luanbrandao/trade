import { BinancePublicClient } from '../binance/public-client';
import { BinancePrivateClient } from '../binance/private-client';
import { ClaudeClient } from '../llm/claude-client';
import { PromptContext } from '../llm/prompt';
import { TradeExecutor, ExecutionMode, ExecutionResult } from '../executor/trade-executor';
import { fetchSnapshot, emaPreFilter } from './market-data';
import { config } from '../config/config';
import { insertDecision, markDecisionExecuted, markDecisionSkipped } from '../storage/decisions';
import { isInCooldown, remainingCooldownMinutes } from '../storage/cooldowns';
import { getOpenTrades } from '../storage/trades';

export interface SymbolResult {
  symbol: string;
  outcome: 'SKIPPED_COOLDOWN' | 'SKIPPED_EMA' | 'SKIPPED_DECISION' | 'EXECUTED' | 'ERROR';
  decisionId?: number;
  executionResult?: ExecutionResult;
  reason?: string;
  costUsd?: number;
}

export class Orchestrator {
  private pub: BinancePublicClient;
  private priv: BinancePrivateClient;
  private claude: ClaudeClient;
  private executor: TradeExecutor;
  private mode: ExecutionMode;

  constructor(mode: ExecutionMode) {
    this.pub = new BinancePublicClient();
    this.priv = new BinancePrivateClient(config.binance.apiKey, config.binance.apiSecret);
    this.claude = new ClaudeClient();
    this.executor = new TradeExecutor(this.priv);
    this.mode = mode;
  }

  async runSymbol(symbol: string): Promise<SymbolResult> {
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

    const ctx: PromptContext = {
      minConfidence: config.trading.minConfidence,
      minRrRatio: config.trading.minRrRatio,
      cooldownMinutes: config.trading.cooldownMinutes,
      amountUsd: config.trading.amountUsd,
      hasOpenPosition,
    };

    let llmResult;
    try {
      llmResult = await this.claude.decide(snapshot, ctx);
    } catch (err: any) {
      return { symbol, outcome: 'ERROR', reason: `Claude failed: ${err.message}` };
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

    if (llmResult.decision.confidence < config.trading.minConfidence) {
      markDecisionSkipped(decisionId, `confidence ${llmResult.decision.confidence} < ${config.trading.minConfidence}`);
      return {
        symbol,
        outcome: 'SKIPPED_DECISION',
        decisionId,
        reason: `confidence ${llmResult.decision.confidence}% < ${config.trading.minConfidence}%`,
        costUsd: llmResult.usage.costUsd,
      };
    }

    const execResult = await this.executor.execute({
      symbol,
      decision: llmResult.decision,
      decisionId,
      currentPrice: snapshot.currentPrice,
      amountUsd: config.trading.amountUsd,
      minRrRatio: config.trading.minRrRatio,
      mode: this.mode,
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

  async runAll(symbols: string[]): Promise<SymbolResult[]> {
    const results: SymbolResult[] = [];
    for (const sym of symbols) {
      results.push(await this.runSymbol(sym));
    }
    return results;
  }
}
