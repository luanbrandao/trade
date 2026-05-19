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
import { insertTrade, TradeRecord, TradeStatus } from '../storage/trades';
import { setCooldown } from '../storage/cooldowns';

export type ExecutionMode = 'dryrun' | 'live' | 'backtest';

export interface ExecutionInput {
  symbol: string;
  decision: TradeDecision;
  decisionId: number;
  currentPrice: number;
  amountUsd: number;
  minRrRatio: number;
  mode: ExecutionMode;
}

export interface ExecutionResult {
  status: 'EXECUTED' | 'SKIPPED' | 'ERROR';
  reason?: string;
  tradeId?: number;
  ocoOrderListId?: string;
  binanceOrderId?: string;
}

export class TradeExecutor {
  constructor(private priv: BinancePrivateClient) {}

  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    const { decision, symbol } = input;

    if (decision.action === 'HOLD') {
      return { status: 'SKIPPED', reason: 'HOLD decision' };
    }

    const rr = decision.takeProfitPercent / decision.stopLossPercent;
    const rrCheck = validateRrFloor(rr, input.minRrRatio);
    if (!rrCheck.ok) {
      return { status: 'SKIPPED', reason: rrCheck.reason };
    }

    if (input.mode === 'dryrun' || input.mode === 'backtest') {
      return this.executeSimulated(input);
    }

    return this.executeLive(input);
  }

  private executeSimulated(input: ExecutionInput): ExecutionResult {
    const { decision, symbol, currentPrice, amountUsd, mode, decisionId } = input;
    const side = decision.action as 'BUY' | 'SELL';
    const qty = amountUsd / currentPrice;

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
      quoteQty: amountUsd,
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
    };
  }

  private async executeLive(input: ExecutionInput): Promise<ExecutionResult> {
    const { decision, symbol, amountUsd, decisionId } = input;
    const side = decision.action as 'BUY' | 'SELL';

    const filters = await this.priv.getSymbolFilters(symbol);

    const notionalCheck = validateMinNotional(amountUsd, filters);
    if (!notionalCheck.ok) {
      return { status: 'SKIPPED', reason: notionalCheck.reason };
    }

    const balanceCheck = await this.checkBalance(side, symbol, amountUsd, input.currentPrice, filters);
    if (!balanceCheck.ok) {
      return { status: 'SKIPPED', reason: balanceCheck.reason };
    }

    let order;
    try {
      order = await this.priv.createMarketOrder(symbol, side, amountUsd);
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
      const oco = await this.priv.createOCOOrder(
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
        await this.priv.createLimitOrder(
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
    };
  }

  private async checkBalance(
    side: 'BUY' | 'SELL',
    symbol: string,
    amountUsd: number,
    currentPrice: number,
    filters: SymbolFilters,
  ): Promise<{ ok: boolean; reason?: string }> {
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
