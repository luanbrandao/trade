import { BinancePrivateClient, SymbolFilters } from '../binance/private-client';
import { TradeDecision } from '../llm/schema';
import {
  calcRiskPrices,
  floorToStep,
  formatToStep,
  formatToTick,
  validateMinNotional,
  validateRrFloor,
} from './risk-manager';
import { insertTrade, getOpenTrades, TradeRecord, TradeStatus } from '../storage/trades';
import { setCooldown } from '../storage/cooldowns';
import { sizePosition, checkHeatCap, SizingMode } from './position-sizer';
import { config } from '../config/config';

export type ExecutionMode = 'dryrun' | 'live' | 'backtest';

export interface ExecutionInput {
  symbol: string;
  decision: TradeDecision;
  decisionId: number;
  currentPrice: number;
  minRrRatio: number;
  mode: ExecutionMode;
  atrAbsolute?: number;
}

export interface ExecutionResult {
  status: 'EXECUTED' | 'SKIPPED' | 'ERROR';
  reason?: string;
  tradeId?: number;
  ocoOrderListId?: string;
  binanceOrderId?: string;
  sizingRationale?: string;
  riskDollars?: number;
}

export class TradeExecutor {
  constructor(private priv: BinancePrivateClient | null) {}

  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    const { decision } = input;

    if (decision.action === 'HOLD') {
      return { status: 'SKIPPED', reason: 'HOLD decision' };
    }

    const rr = decision.takeProfitPercent / decision.stopLossPercent;
    const rrCheck = validateRrFloor(rr, input.minRrRatio);
    if (!rrCheck.ok) {
      return { status: 'SKIPPED', reason: rrCheck.reason };
    }

    const sizing = sizePosition({
      mode: config.trading.sizingMode as SizingMode,
      accountEquityUsd: config.trading.accountEquityUsd,
      fixedAmountUsd: config.trading.amountUsd,
      riskPctPerTrade: config.trading.riskPctPerTrade,
      entryPrice: input.currentPrice,
      stopLossPercent: decision.stopLossPercent,
      atrAbsolute: input.atrAbsolute,
      atrMultiplier: config.trading.atrMultiplier,
    });

    if (sizing.quoteQty > config.trading.amountUsd && config.trading.sizingMode !== 'fixed') {
      sizing.quoteQty = config.trading.amountUsd;
      sizing.baseQty = sizing.quoteQty / input.currentPrice;
      sizing.rationale += ` (capped by TRADE_AMOUNT_USD=$${config.trading.amountUsd})`;
    }

    const openTrades = getOpenTrades();
    const heatCheck = checkHeatCap(
      sizing.riskDollars,
      openTrades,
      config.trading.accountEquityUsd,
      config.trading.maxPortfolioHeatPct,
    );
    if (!heatCheck.ok) {
      return { status: 'SKIPPED', reason: heatCheck.reason };
    }

    if (input.mode === 'dryrun' || input.mode === 'backtest') {
      return this.executeSimulated(input, sizing.quoteQty, sizing.riskDollars, sizing.rationale);
    }

    return this.executeLive(input, sizing.quoteQty, sizing.riskDollars, sizing.rationale);
  }

  private executeSimulated(
    input: ExecutionInput,
    quoteQty: number,
    riskDollars: number,
    rationale: string,
  ): ExecutionResult {
    const { decision, symbol, currentPrice, mode, decisionId } = input;
    const side = decision.action as 'BUY' | 'SELL';
    const qty = quoteQty / currentPrice;

    const isLong = side === 'BUY';
    const tpPrice = currentPrice * (1 + (isLong ? decision.takeProfitPercent : -decision.takeProfitPercent) / 100);
    const slPrice = currentPrice * (1 + (isLong ? -decision.stopLossPercent : decision.stopLossPercent) / 100);

    const record: TradeRecord = {
      decisionId,
      ts: Date.now(),
      symbol,
      side,
      qty,
      avgPrice: currentPrice,
      quoteQty,
      binanceOrderId: `SIM-${Date.now()}`,
      ocoOrderListId: null,
      tpPrice,
      slPrice,
      status: 'OPEN' as TradeStatus,
      closedTs: null,
      closedPrice: null,
      pnlQuote: null,
      pnlPct: null,
      mode,
    };
    const tradeId = insertTrade(record);
    setCooldown(symbol);

    return {
      status: 'EXECUTED',
      tradeId,
      binanceOrderId: record.binanceOrderId,
      sizingRationale: rationale,
      riskDollars,
    };
  }

  private async executeLive(
    input: ExecutionInput,
    quoteQty: number,
    riskDollars: number,
    rationale: string,
  ): Promise<ExecutionResult> {
    if (!this.priv) {
      return { status: 'ERROR', reason: 'Live mode requires private client (Binance keys)' };
    }
    const priv = this.priv;
    const { decision, symbol, decisionId } = input;
    const side = decision.action as 'BUY' | 'SELL';

    const filters = await priv.getSymbolFilters(symbol);

    const notionalCheck = validateMinNotional(quoteQty, filters);
    if (!notionalCheck.ok) {
      return { status: 'SKIPPED', reason: notionalCheck.reason };
    }

    const balanceCheck = await this.checkBalance(side, symbol, quoteQty, input.currentPrice, filters);
    if (!balanceCheck.ok) {
      return { status: 'SKIPPED', reason: balanceCheck.reason };
    }

    let order;
    try {
      order = await priv.createMarketOrder(symbol, side, quoteQty);
    } catch (err: any) {
      const msg = err.response?.data?.msg ?? err.message;
      return { status: 'ERROR', reason: `MARKET order failed: ${msg}` };
    }

    const executedQty = parseFloat(order.executedQty);
    const fillPrice = order.fills?.[0]?.price
      ? parseFloat(order.fills[0].price)
      : parseFloat(order.cummulativeQuoteQty) / executedQty;

    const risk = calcRiskPrices(fillPrice, side, decision.stopLossPercent, decision.takeProfitPercent, filters);

    const closingSide: 'BUY' | 'SELL' = side === 'BUY' ? 'SELL' : 'BUY';
    const closingQty = floorToStep(executedQty, filters.stepSize || 0.0001);

    let ocoOrderListId: string | null = null;
    try {
      const oco = await priv.createOCOOrder(
        symbol,
        closingSide,
        parseFloat(formatToStep(closingQty, filters.stepSize || 0.0001)),
        parseFloat(formatToTick(risk.takeProfitPrice, filters.tickSize || 0.01)),
        parseFloat(formatToTick(risk.stopPrice, filters.tickSize || 0.01)),
        parseFloat(formatToTick(risk.stopLimitPrice, filters.tickSize || 0.01)),
      );
      ocoOrderListId = String(oco.orderListId);
    } catch (err: any) {
      const msg = err.response?.data?.msg ?? err.message;
      console.warn(`OCO failed (${msg}) — falling back to LIMIT TP only`);
      try {
        await priv.createLimitOrder(
          symbol,
          closingSide,
          parseFloat(formatToStep(closingQty, filters.stepSize || 0.0001)),
          parseFloat(formatToTick(risk.takeProfitPrice, filters.tickSize || 0.01)),
        );
      } catch (tpErr: any) {
        const tpMsg = tpErr.response?.data?.msg ?? tpErr.message;
        console.error(`LIMIT TP fallback also failed (${tpMsg}) — position is unprotected, configure manually`);
      }
    }

    const record: TradeRecord = {
      decisionId,
      ts: Date.now(),
      symbol,
      side,
      qty: executedQty,
      avgPrice: fillPrice,
      quoteQty: parseFloat(order.cummulativeQuoteQty),
      binanceOrderId: String(order.orderId),
      ocoOrderListId,
      tpPrice: risk.takeProfitPrice,
      slPrice: risk.stopPrice,
      status: 'OPEN' as TradeStatus,
      closedTs: null,
      closedPrice: null,
      pnlQuote: null,
      pnlPct: null,
      mode: 'live',
    };
    const tradeId = insertTrade(record);
    setCooldown(symbol);

    return {
      status: 'EXECUTED',
      tradeId,
      binanceOrderId: String(order.orderId),
      ocoOrderListId: ocoOrderListId ?? undefined,
      sizingRationale: rationale,
      riskDollars,
    };
  }

  private async checkBalance(
    side: 'BUY' | 'SELL',
    symbol: string,
    amountUsd: number,
    currentPrice: number,
    filters: SymbolFilters,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!this.priv) return { ok: false, reason: 'private client unavailable' };
    if (side === 'BUY') {
      const { free } = await this.priv.getBalance(filters.quoteAsset);
      if (free < amountUsd) {
        return { ok: false, reason: `${filters.quoteAsset} balance ${free.toFixed(2)} < required ${amountUsd}` };
      }
      return { ok: true };
    }

    const { free } = await this.priv.getBalance(filters.baseAsset);
    const requiredQty = amountUsd / currentPrice;
    if (free < requiredQty) {
      return {
        ok: false,
        reason: `${filters.baseAsset} balance ${free} < required ${requiredQty.toFixed(6)}`,
      };
    }
    return { ok: true };
  }
}
