import { BinancePublicClient } from '../binance/public-client';
import { BinancePrivateClient } from '../binance/private-client';
import { getOpenTrades, closeTrade, TradeRecord, TradeStatus } from '../storage/trades';
import {
  insertPostmortem,
  postmortemExistsForTrade,
  PostmortemOutcome,
  PostmortemClassification,
} from '../storage/postmortems';
import { config } from '../config/config';
import { log } from '../logger';

export interface CloserResult {
  checked: number;
  closed: number;
  errors: number;
}

export class TradeCloser {
  constructor(private pub: BinancePublicClient, private priv: BinancePrivateClient | null) {}

  async runLive(): Promise<CloserResult> {
    const open = getOpenTrades().filter((t) => t.mode === 'live');
    return this.processBatch(open);
  }

  private async processBatch(trades: TradeRecord[]): Promise<CloserResult> {
    const result: CloserResult = { checked: trades.length, closed: 0, errors: 0 };

    for (const trade of trades) {
      if (!trade.id) continue;
      if (postmortemExistsForTrade(trade.id)) continue;

      try {
        const closed = await this.tryCloseLive(trade);
        if (closed) result.closed += 1;
      } catch (err: any) {
        log.error('Closer error', { tradeId: trade.id, symbol: trade.symbol, err: err.message });
        result.errors += 1;
      }
    }

    return result;
  }

  private async tryCloseLive(trade: TradeRecord): Promise<boolean> {
    if (!this.priv) throw new Error('Live closer requires private client');
    if (!trade.id) return false;

    const history = await this.priv.getOrderHistory(trade.symbol, 50);
    const closingSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
    const fill = history.find(
      (o) =>
        o.side === closingSide &&
        o.status === 'FILLED' &&
        o.transactTime > trade.ts,
    );

    if (!fill) return false;

    const exitPrice = parseFloat(fill.cummulativeQuoteQty) / parseFloat(fill.executedQty);
    const outcome = this.classifyExit(trade, exitPrice);
    await this.persistClose(trade, exitPrice, fill.transactTime, outcome);
    return true;
  }

  private classifyExit(trade: TradeRecord, exitPrice: number): PostmortemOutcome {
    if (trade.tpPrice && trade.slPrice) {
      const tpDist = Math.abs(exitPrice - trade.tpPrice) / trade.tpPrice;
      const slDist = Math.abs(exitPrice - trade.slPrice) / trade.slPrice;
      if (tpDist < 0.002) return 'TP_HIT';
      if (slDist < 0.002) return 'SL_HIT';
    }
    return 'MANUAL';
  }

  async persistClose(
    trade: TradeRecord,
    exitPrice: number,
    closedTs: number,
    outcome: PostmortemOutcome,
    notes: string | null = null,
  ): Promise<void> {
    if (!trade.id) return;

    const isLong = trade.side === 'BUY';
    // Net of exchange fees on both sides — gross PnL overstates results by
    // ~2x fee per round trip, which is material on tight-target strategies.
    const fees = (trade.avgPrice + exitPrice) * trade.qty * (config.trading.feePctPerSide / 100);
    const grossQuote = isLong
      ? (exitPrice - trade.avgPrice) * trade.qty
      : (trade.avgPrice - exitPrice) * trade.qty;
    const pnlQuote = grossQuote - fees;
    const pnlPct = (pnlQuote / (trade.avgPrice * trade.qty)) * 100;
    const holdingMinutes = (closedTs - trade.ts) / 60_000;

    const tradeStatus: TradeStatus =
      outcome === 'TP_HIT' ? 'TP_FILLED' : outcome === 'SL_HIT' ? 'SL_FILLED' : 'CANCELED';
    closeTrade(trade.id, tradeStatus, exitPrice, pnlQuote, pnlPct);

    const maeMfe = await this.computeMaeMfe(trade, closedTs);

    const classification: PostmortemClassification = this.classify(outcome, pnlQuote);

    insertPostmortem({
      tradeId: trade.id,
      closedTs,
      outcome,
      pnlQuote,
      pnlPct,
      holdingMinutes,
      maePct: maeMfe?.maePct ?? null,
      mfePct: maeMfe?.mfePct ?? null,
      classification,
      notes,
    });

    log.info('Trade closed + postmortem recorded', {
      tradeId: trade.id,
      symbol: trade.symbol,
      outcome,
      pnlPct: pnlPct.toFixed(2),
      classification,
      notes,
    });
  }

  private classify(outcome: PostmortemOutcome, pnlQuote: number): PostmortemClassification {
    if (outcome === 'TP_HIT') return 'TRUE_POSITIVE';
    if (outcome === 'SL_HIT') return 'FALSE_POSITIVE';
    return pnlQuote > 0 ? 'TIMEOUT_WIN' : 'TIMEOUT_LOSS';
  }

  private async computeMaeMfe(
    trade: TradeRecord,
    closedTs: number,
  ): Promise<{ maePct: number; mfePct: number } | null> {
    try {
      const klines = await this.pub.getKlines(trade.symbol, '15m', 200, trade.ts, closedTs);
      if (klines.length === 0) return null;

      const isLong = trade.side === 'BUY';
      let worstAdverse = trade.avgPrice;
      let bestFavorable = trade.avgPrice;

      for (const k of klines) {
        if (isLong) {
          if (k.low < worstAdverse) worstAdverse = k.low;
          if (k.high > bestFavorable) bestFavorable = k.high;
        } else {
          if (k.high > worstAdverse) worstAdverse = k.high;
          if (k.low < bestFavorable) bestFavorable = k.low;
        }
      }

      const maePct = isLong
        ? ((trade.avgPrice - worstAdverse) / trade.avgPrice) * 100
        : ((worstAdverse - trade.avgPrice) / trade.avgPrice) * 100;
      const mfePct = isLong
        ? ((bestFavorable - trade.avgPrice) / trade.avgPrice) * 100
        : ((trade.avgPrice - bestFavorable) / trade.avgPrice) * 100;

      return { maePct, mfePct };
    } catch (err: any) {
      log.warn('MAE/MFE calc failed', { tradeId: trade.id, err: err.message });
      return null;
    }
  }
}
