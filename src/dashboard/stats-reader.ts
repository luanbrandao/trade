import { config } from '../config/config';
import { effectiveSettings } from '../config/effective-settings';
import { getDb } from '../storage/db';
import { collectStats } from '../stats/collect';
import { getPerformanceSummary } from '../stats/performance-summary';
import { currentPortfolioHeatPct } from '../executor/position-sizer';
import { detectRegime } from '../strategy/regime';
import { effectiveMinConfidence, maxPositionsForRegime } from '../strategy/regime-policy';
import { Regime } from '../strategy/regime';
import { BinancePublicClient } from '../binance/public-client';
import { TradeRecord } from '../storage/trades';
import { log } from '../logger';
import { PriceCache } from './binance-prices';
import { collectLlmCost } from './llm-cost';
import {
  DashboardSnapshot,
  StatsSnapshot,
  OpenTradeView,
  ClosedTradeView,
  DecisionView,
  LoopStatus,
  RegimeView,
  CalibrationView,
  HeatView,
} from './types';

export class StatsReader {
  private pub = new BinancePublicClient();

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
        stop: t.sl_price,
        target: t.tp_price,
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

    const eff = effectiveSettings();

    // Regime + effective confidence floor: explains WHY the bot is holding
    // (the floor rises +10 in CHOPPY / +5 in UNKNOWN). detectRegime caches
    // 15 min in-process, so this is one Binance fetch per window.
    let regime: RegimeView | null = null;
    try {
      const r = await detectRegime(this.pub);
      regime = {
        regime: r.regime,
        btcTrend: r.btcTrend,
        btcEma50Slope: r.btcEma50Slope,
        btcChange30dPct: r.btcChange30dPct,
        fearGreedIndex: r.fearGreedIndex,
        fearGreedLabel: r.fearGreedLabel,
        baseMinConfidence: eff.minConfidence,
        effectiveMinConfidence: effectiveMinConfidence(eff.minConfidence, r.regime as Regime),
        maxOpenPositions: config.trading.maxOpenPositions,
        positionLimit: maxPositionsForRegime(config.trading.maxOpenPositions, r.regime as Regime),
      };
    } catch (err: any) {
      log.warn('Dashboard regime fetch failed', { err: err.message });
    }

    let calibration: CalibrationView | null = null;
    try {
      calibration = getPerformanceSummary('dryrun');
    } catch (err: any) {
      log.warn('Dashboard calibration read failed', { err: err.message });
    }

    const heatTrades: TradeRecord[] = stats.open.map((t) => ({
      decisionId: null,
      ts: t.ts,
      symbol: t.symbol,
      side: t.side,
      qty: t.qty,
      avgPrice: t.avg_price,
      quoteQty: t.avg_price * t.qty,
      binanceOrderId: '',
      ocoOrderListId: null,
      tpPrice: t.tp_price,
      slPrice: t.sl_price,
      status: 'OPEN',
      closedTs: null,
      closedPrice: null,
      pnlQuote: null,
      pnlPct: null,
      mode: 'dryrun',
      strategyName: t.strategy_name,
    }));
    const heat: HeatView = {
      currentPct: currentPortfolioHeatPct(heatTrades, eff.accountEquityUsd),
      capPct: eff.maxPortfolioHeatPct,
    };

    return {
      loop: { ...loop, lastTickAt: this.lastTickAt(strategyName) },
      stats: statsSnap,
      openTrades,
      closedTrades,
      decisions,
      equityCurve: stats.equityCurve,
      llmCost: collectLlmCost(strategyName),
      llm: { provider: eff.llmProvider, model: eff.llmModel },
      regime,
      calibration,
      heat,
    };
  }
}
