import { config } from '../config/config';
import { effectiveSettings } from '../config/effective-settings';
import { getDb } from '../storage/db';
import { collectStats } from '../stats/collect';
import { PriceCache } from './binance-prices';
import { collectLlmCost } from './llm-cost';
import {
  DashboardSnapshot,
  StatsSnapshot,
  OpenTradeView,
  ClosedTradeView,
  DecisionView,
  LoopStatus,
} from './types';

export class StatsReader {
  constructor(private prices: PriceCache = new PriceCache()) {}

  lastTickAt(strategyName: string): number | null {
    const row = getDb()
      .prepare(`SELECT MAX(ts) AS maxTs FROM decisions WHERE strategy_name = ? AND mode = 'dryrun'`)
      .get(strategyName) as { maxTs: number | null };
    return row.maxTs ?? null;
  }

  async snapshot(loop: LoopStatus): Promise<DashboardSnapshot> {
    const strategyName = config.trading.strategyName;
    const stats = collectStats(strategyName, undefined);

    const symbols = Array.from(new Set(stats.open.map((t) => t.symbol)));
    const priceMap = await this.prices.getPrices(symbols);

    const openTrades: OpenTradeView[] = stats.open.map((t) => {
      const price = priceMap[t.symbol] ?? t.avg_price;
      const isLong = t.side === 'BUY';
      const pnlQuote = (isLong ? price - t.avg_price : t.avg_price - price) * t.qty;
      const pnlPct = isLong
        ? ((price - t.avg_price) / t.avg_price) * 100
        : ((t.avg_price - price) / t.avg_price) * 100;
      return {
        id: t.id,
        ts: t.ts,
        symbol: t.symbol,
        side: t.side,
        qty: t.qty,
        entry: t.avg_price,
        currentPrice: price,
        pnlQuote,
        pnlPct,
        strategyName: t.strategy_name,
      };
    });
    const openPnlQuote = openTrades.reduce((s, t) => s + t.pnlQuote, 0);

    const closedTrades: ClosedTradeView[] = [...stats.closed]
      .reverse()
      .slice(0, 50)
      .map((t) => ({
        id: t.id,
        ts: t.ts,
        closedTs: t.closed_ts,
        symbol: t.symbol,
        side: t.side,
        entry: t.avg_price,
        exit: t.closed_price,
        pnlQuote: t.pnl_quote,
        pnlPct: t.pnl_pct,
        status: t.status,
        holdingHours: (t.closed_ts - t.ts) / 3_600_000,
        strategyName: t.strategy_name,
      }));

    const decRows = getDb()
      .prepare(
        `SELECT ts, symbol, action, confidence, reason, executed, skip_reason
         FROM decisions
         WHERE strategy_name = ? AND mode = 'dryrun'
         ORDER BY ts DESC
         LIMIT 20`,
      )
      .all(strategyName) as {
      ts: number;
      symbol: string;
      action: 'BUY' | 'SELL' | 'HOLD';
      confidence: number;
      reason: string | null;
      executed: number;
      skip_reason: string | null;
    }[];

    const decisions: DecisionView[] = decRows.map((d) => ({
      ts: d.ts,
      symbol: d.symbol,
      action: d.action,
      confidence: d.confidence,
      reason: d.reason,
      executed: !!d.executed,
      skipReason: d.skip_reason,
    }));

    const statsSnap: StatsSnapshot = {
      strategyName: stats.strategyName,
      windowStart: stats.windowStart,
      windowEnd: stats.windowEnd,
      startingEquity: stats.startingEquity,
      equityNow: stats.equityNow,
      realizedPnlQuote: stats.realizedPnlQuote,
      realizedPnlPct: stats.realizedPnlPct,
      openPnlQuote,
      winRateTotal: stats.winRateTotal,
      winRateBuy: stats.winRateBuy,
      winRateSell: stats.winRateSell,
      winsBuy: stats.winsBuy,
      totalBuy: stats.totalBuy,
      winsSell: stats.winsSell,
      totalSell: stats.totalSell,
      maxDdPct: stats.maxDdPct,
      avgHoldingMinutes: stats.avgHoldingMinutes,
      avgRrRatio: stats.avgRrRatio,
      tradesClosed: stats.closed.length,
      tradesOpen: stats.open.length,
      dailyGate: {
        allowed: stats.dailyGateReason === null,
        reason: stats.dailyGateReason,
        ddPct: stats.dailyGateDdPct,
        streak: stats.dailyGateStreak,
      },
    };

    return {
      loop: { ...loop, lastTickAt: this.lastTickAt(strategyName) },
      stats: statsSnap,
      openTrades,
      closedTrades,
      decisions,
      equityCurve: stats.equityCurve,
      llmCost: collectLlmCost(strategyName),
      llm: (() => {
        const eff = effectiveSettings();
        return { provider: eff.llmProvider, model: eff.llmModel };
      })(),
    };
  }
}
