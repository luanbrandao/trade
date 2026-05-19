import { BinancePublicClient } from '../binance/public-client';
import { Kline } from '../binance/types';
import { TradeCloser, CloserResult } from '../postmortem/closer';
import { getOpenTrades, TradeRecord } from '../storage/trades';
import { postmortemExistsForTrade, PostmortemOutcome } from '../storage/postmortems';
import { config } from '../config/config';
import { log } from '../logger';

export interface FillCandidate {
  id: number;
  side: 'BUY' | 'SELL';
  avgPrice: number;
  tpPrice: number;
  slPrice: number;
  openTs: number;
  maxHoldHours: number;
}

export interface FillResult {
  outcome: PostmortemOutcome;
  exitPrice: number;
  closedTs: number;
  notes?: string;
}

export function simulateFill(
  trade: FillCandidate,
  klines: Kline[],
  fallbackCurrentPrice: number,
  nowMs?: number,
): FillResult | null {
  const isLong = trade.side === 'BUY';
  const now = nowMs ?? Date.now();
  const maxHoldMs = trade.maxHoldHours * 3_600_000;

  for (const c of klines) {
    if (c.openTime < trade.openTs) continue;

    if (isLong) {
      const tpHit = c.high >= trade.tpPrice;
      const slHit = c.low <= trade.slPrice;
      if (tpHit && slHit) {
        return {
          outcome: 'SL_HIT',
          exitPrice: trade.slPrice,
          closedTs: c.closeTime,
          notes: 'AMBIGUOUS_SAME_CANDLE_15M',
        };
      }
      if (tpHit) return { outcome: 'TP_HIT', exitPrice: trade.tpPrice, closedTs: c.closeTime };
      if (slHit) return { outcome: 'SL_HIT', exitPrice: trade.slPrice, closedTs: c.closeTime };
    } else {
      const tpHit = c.low <= trade.tpPrice;
      const slHit = c.high >= trade.slPrice;
      if (tpHit && slHit) {
        return {
          outcome: 'SL_HIT',
          exitPrice: trade.slPrice,
          closedTs: c.closeTime,
          notes: 'AMBIGUOUS_SAME_CANDLE_15M',
        };
      }
      if (tpHit) return { outcome: 'TP_HIT', exitPrice: trade.tpPrice, closedTs: c.closeTime };
      if (slHit) return { outcome: 'SL_HIT', exitPrice: trade.slPrice, closedTs: c.closeTime };
    }
  }

  if (now - trade.openTs >= maxHoldMs) {
    return { outcome: 'TIMEOUT', exitPrice: fallbackCurrentPrice, closedTs: now };
  }

  return null;
}

export class FillSimulator {
  constructor(private pub: BinancePublicClient, private closer: TradeCloser) {}

  async runDryrunFillSim(): Promise<CloserResult> {
    const open = getOpenTrades().filter((t) => t.mode === 'dryrun');
    const result: CloserResult = { checked: open.length, closed: 0, errors: 0 };

    for (const trade of open) {
      if (!trade.id) continue;
      if (postmortemExistsForTrade(trade.id)) continue;
      if (trade.tpPrice == null || trade.slPrice == null) continue;

      try {
        const closed = await this.tryCloseOne(trade);
        if (closed) result.closed += 1;
      } catch (err: any) {
        log.error('FillSimulator error', { tradeId: trade.id, symbol: trade.symbol, err: err.message });
        result.errors += 1;
      }
    }

    return result;
  }

  private async tryCloseOne(trade: TradeRecord): Promise<boolean> {
    if (!trade.id) return false;
    if (trade.tpPrice == null || trade.slPrice == null) return false;

    const klines = await this.pub.getKlines(trade.symbol, '15m', 1000, trade.ts, Date.now());

    let currentPrice = trade.avgPrice;
    try {
      currentPrice = parseFloat((await this.pub.getPrice(trade.symbol)).price);
    } catch {
      // fall back to avgPrice for timeout exit if price fetch fails
    }

    const sim = simulateFill(
      {
        id: trade.id,
        side: trade.side,
        avgPrice: trade.avgPrice,
        tpPrice: trade.tpPrice,
        slPrice: trade.slPrice,
        openTs: trade.ts,
        maxHoldHours: config.trading.dryrunMaxHoldHours,
      },
      klines,
      currentPrice,
    );

    if (!sim) return false;

    await this.closer.persistClose(trade, sim.exitPrice, sim.closedTs, sim.outcome, sim.notes ?? null);
    return true;
  }
}
