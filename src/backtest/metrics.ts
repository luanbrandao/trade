import { SimulatedTrade } from './engine';

export interface BacktestMetrics {
  trades: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  totalPnlQuote: number;
  totalPnlPct: number;
  avgPnlPct: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgHoldMinutes: number;
  avgRrAchieved: number;
  sharpeRatio: number;
  bestTrade: SimulatedTrade | null;
  worstTrade: SimulatedTrade | null;
}

export function computeMetrics(trades: SimulatedTrade[]): BacktestMetrics {
  if (trades.length === 0) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      timeouts: 0,
      winRate: 0,
      totalPnlQuote: 0,
      totalPnlPct: 0,
      avgPnlPct: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      profitFactor: 0,
      maxDrawdownPct: 0,
      avgHoldMinutes: 0,
      avgRrAchieved: 0,
      sharpeRatio: 0,
      bestTrade: null,
      worstTrade: null,
    };
  }

  const wins = trades.filter((t) => t.pnlQuote > 0);
  const losses = trades.filter((t) => t.pnlQuote <= 0);
  const timeouts = trades.filter((t) => t.outcome === 'TIMEOUT');

  const totalPnlQuote = trades.reduce((s, t) => s + t.pnlQuote, 0);
  const totalPnlPct = trades.reduce((s, t) => s + t.pnlPct, 0);
  const avgPnlPct = totalPnlPct / trades.length;

  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

  const grossProfit = wins.reduce((s, t) => s + t.pnlQuote, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlQuote, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  let runningPnl = 0;
  let peak = 0;
  let maxDrawdownPct = 0;
  for (const t of trades) {
    runningPnl += t.pnlPct;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  const avgHoldMinutes = trades.reduce((s, t) => s + t.holdMinutes, 0) / trades.length;
  const avgRrAchieved =
    trades.reduce((s, t) => {
      const rUnit = (t.entryPrice - t.slPrice) / t.entryPrice;
      const move = (t.exitPrice - t.entryPrice) / t.entryPrice;
      return s + (rUnit > 0 ? move / rUnit : 0);
    }, 0) / trades.length;

  const meanPct = avgPnlPct;
  const variance = trades.reduce((s, t) => s + (t.pnlPct - meanPct) ** 2, 0) / trades.length;
  const stdev = Math.sqrt(variance);
  const sharpeRatio = stdev > 0 ? meanPct / stdev : 0;

  const sorted = [...trades].sort((a, b) => b.pnlPct - a.pnlPct);

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    timeouts: timeouts.length,
    winRate: wins.length / trades.length,
    totalPnlQuote,
    totalPnlPct,
    avgPnlPct,
    avgWinPct,
    avgLossPct,
    profitFactor,
    maxDrawdownPct,
    avgHoldMinutes,
    avgRrAchieved,
    sharpeRatio,
    bestTrade: sorted[0],
    worstTrade: sorted[sorted.length - 1],
  };
}

export function formatMetrics(m: BacktestMetrics, symbol: string): string {
  const lines: string[] = [];
  lines.push(`\n=== Backtest Results — ${symbol} ===`);
  lines.push(`Trades: ${m.trades}  (Wins: ${m.wins}  Losses: ${m.losses}  Timeouts: ${m.timeouts})`);
  lines.push(`Win rate: ${(m.winRate * 100).toFixed(1)}%`);
  lines.push(`Total PnL: ${m.totalPnlQuote.toFixed(2)} USDT  (${m.totalPnlPct.toFixed(2)}% cumulative)`);
  lines.push(`Avg PnL/trade: ${m.avgPnlPct.toFixed(2)}%  (Win: ${m.avgWinPct.toFixed(2)}%, Loss: ${m.avgLossPct.toFixed(2)}%)`);
  lines.push(`Profit factor: ${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)}`);
  lines.push(`Max drawdown: ${m.maxDrawdownPct.toFixed(2)}%`);
  lines.push(`Avg hold: ${m.avgHoldMinutes.toFixed(0)} min`);
  lines.push(`Avg R/R achieved: ${m.avgRrAchieved.toFixed(2)}`);
  lines.push(`Sharpe (per-trade): ${m.sharpeRatio.toFixed(2)}`);
  if (m.bestTrade) {
    const ts = new Date(m.bestTrade.entryTs).toISOString().slice(0, 10);
    lines.push(`Best:  ${ts}  ${m.bestTrade.pnlPct.toFixed(2)}%  (${m.bestTrade.outcome})`);
  }
  if (m.worstTrade) {
    const ts = new Date(m.worstTrade.entryTs).toISOString().slice(0, 10);
    lines.push(`Worst: ${ts}  ${m.worstTrade.pnlPct.toFixed(2)}%  (${m.worstTrade.outcome})`);
  }
  return lines.join('\n');
}
