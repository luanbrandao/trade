import { getDb } from './db';

export function setCooldown(symbol: string, ts: number = Date.now()): void {
  getDb()
    .prepare(`
      INSERT INTO cooldowns (symbol, last_trade_ts) VALUES (?, ?)
      ON CONFLICT(symbol) DO UPDATE SET last_trade_ts = excluded.last_trade_ts
    `)
    .run(symbol, ts);
}

export function getLastTradeTs(symbol: string): number | null {
  const row = getDb()
    .prepare('SELECT last_trade_ts FROM cooldowns WHERE symbol = ?')
    .get(symbol) as { last_trade_ts: number } | undefined;
  return row ? row.last_trade_ts : null;
}

export function isInCooldown(symbol: string, cooldownMinutes: number): boolean {
  const last = getLastTradeTs(symbol);
  if (last === null) return false;
  const elapsedMs = Date.now() - last;
  return elapsedMs < cooldownMinutes * 60_000;
}

export function remainingCooldownMinutes(symbol: string, cooldownMinutes: number): number {
  const last = getLastTradeTs(symbol);
  if (last === null) return 0;
  const elapsedMin = (Date.now() - last) / 60_000;
  return Math.max(0, cooldownMinutes - elapsedMin);
}
