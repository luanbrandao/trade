import { Regime } from './regime';

/**
 * Regime-aware confidence floor. The prompt asks the model to be more
 * conservative in chop, but enforcing it in code makes it non-negotiable —
 * shared by the live orchestrator and the backtest so both apply the same bar.
 */
export function effectiveMinConfidence(base: number, regime?: Regime): number {
  if (regime === 'CHOPPY') return Math.min(100, base + 10);
  if (regime === 'UNKNOWN') return Math.min(100, base + 5);
  return base;
}

/**
 * BTC/ETH/SOL move together; portfolio heat treats their risks as independent,
 * so cap concurrent positions harder when the macro regime is unfavorable.
 */
export function maxPositionsForRegime(maxOpenPositions: number, regime?: Regime): number {
  if (regime === 'RISK_OFF') return Math.min(maxOpenPositions, 1);
  if (regime === 'CHOPPY') return Math.min(maxOpenPositions, 2);
  return maxOpenPositions;
}
