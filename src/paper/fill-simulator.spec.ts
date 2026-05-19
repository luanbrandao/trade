import { describe, it, expect } from 'vitest';
import { simulateFill, FillCandidate } from './fill-simulator';
import { Kline } from '../binance/types';

function k(openTime: number, low: number, high: number): Kline {
  return {
    openTime,
    open: low,
    high,
    low,
    close: high,
    volume: 1,
    closeTime: openTime + 15 * 60_000 - 1,
    trades: 1,
  };
}

describe('simulateFill', () => {
  const baseTrade: FillCandidate = {
    id: 1,
    side: 'BUY',
    avgPrice: 60000,
    tpPrice: 61200,
    slPrice: 59400,
    openTs: 0,
    maxHoldHours: 168,
  };

  it('BUY: TP hit isolated', () => {
    const klines = [k(0, 59900, 61300)];
    const result = simulateFill(baseTrade, klines, 1000);
    expect(result?.outcome).toBe('TP_HIT');
    expect(result?.exitPrice).toBe(61200);
  });

  it('BUY: SL hit isolated', () => {
    const klines = [k(0, 59300, 60100)];
    const result = simulateFill(baseTrade, klines, 1000);
    expect(result?.outcome).toBe('SL_HIT');
    expect(result?.exitPrice).toBe(59400);
  });

  it('BUY: same-candle whipsaw → pessimistic SL first', () => {
    const klines = [k(0, 59300, 61300)];
    const result = simulateFill(baseTrade, klines, 1000);
    expect(result?.outcome).toBe('SL_HIT');
    expect(result?.notes).toBe('AMBIGUOUS_SAME_CANDLE_15M');
  });

  it('SELL: TP hit isolated', () => {
    const sell: FillCandidate = { ...baseTrade, side: 'SELL', tpPrice: 58800, slPrice: 60600 };
    const klines = [k(0, 58700, 60100)];
    const result = simulateFill(sell, klines, 1000);
    expect(result?.outcome).toBe('TP_HIT');
    expect(result?.exitPrice).toBe(58800);
  });

  it('SELL: SL hit isolated', () => {
    const sell: FillCandidate = { ...baseTrade, side: 'SELL', tpPrice: 58800, slPrice: 60600 };
    const klines = [k(0, 59800, 60700)];
    const result = simulateFill(sell, klines, 1000);
    expect(result?.outcome).toBe('SL_HIT');
    expect(result?.exitPrice).toBe(60600);
  });

  it('SELL: same-candle whipsaw → pessimistic SL first', () => {
    const sell: FillCandidate = { ...baseTrade, side: 'SELL', tpPrice: 58800, slPrice: 60600 };
    const klines = [k(0, 58700, 60700)];
    const result = simulateFill(sell, klines, 1000);
    expect(result?.outcome).toBe('SL_HIT');
    expect(result?.notes).toBe('AMBIGUOUS_SAME_CANDLE_15M');
  });

  it('no hit within candles → null', () => {
    const klines = [k(0, 59500, 61100), k(15 * 60_000, 59500, 61100)];
    const result = simulateFill(baseTrade, klines, 1000, 30 * 60_000);
    expect(result).toBeNull();
  });

  it('exceeds max hold → TIMEOUT at provided current price', () => {
    const trade: FillCandidate = { ...baseTrade, maxHoldHours: 1, openTs: 0 };
    const now = 2 * 3_600_000;
    const klines = [k(0, 59500, 61100)];
    const result = simulateFill(trade, klines, 60050, now);
    expect(result?.outcome).toBe('TIMEOUT');
    expect(result?.exitPrice).toBe(60050);
  });

  it('first candle to hit wins (chronological order)', () => {
    const noHit = k(0, 59500, 61100);
    const tpHit = k(15 * 60_000, 59500, 61300);
    const result = simulateFill(baseTrade, [noHit, tpHit], 1000);
    expect(result?.outcome).toBe('TP_HIT');
    expect(result?.closedTs).toBe(tpHit.closeTime);
  });
});
