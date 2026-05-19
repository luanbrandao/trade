import { SimulatedTrade } from './engine';

export interface YearMetric {
  year: number;
  trades: number;
  winRate: number;
  pnlPct: number;
}

export type Verdict = 'DEPLOY' | 'REFINE' | 'ABANDON';

export interface VerdictResult {
  verdict: Verdict;
  score: number;
  dimensions: {
    sampleSize: number;
    expectancy: number;
    riskManagement: number;
    robustness: number;
    executionRealism: number;
  };
  redFlags: string[];
}

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
  yearByYear: YearMetric[];
  verdict: VerdictResult;
}

function emptyVerdict(): VerdictResult {
  return {
    verdict: 'ABANDON',
    score: 0,
    dimensions: {
      sampleSize: 0,
      expectancy: 0,
      riskManagement: 0,
      robustness: 0,
      executionRealism: 0,
    },
    redFlags: ['no trades'],
  };
}

export function computeMetrics(
  trades: SimulatedTrade[],
  opts: { slippageTested?: boolean } = {},
): BacktestMetrics {
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
      yearByYear: [],
      verdict: emptyVerdict(),
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

  const yearByYear = computeYearByYear(trades);
  const verdict = computeVerdict({
    trades: trades.length,
    winRate: wins.length / trades.length,
    profitFactor,
    avgPnlPct,
    maxDrawdownPct,
    yearByYear,
    slippageTested: opts.slippageTested ?? false,
  });

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
    yearByYear,
    verdict,
  };
}

function computeYearByYear(trades: SimulatedTrade[]): YearMetric[] {
  const byYear = new Map<number, SimulatedTrade[]>();
  for (const t of trades) {
    const y = new Date(t.entryTs).getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(t);
  }
  const result: YearMetric[] = [];
  for (const [year, ts] of [...byYear.entries()].sort(([a], [b]) => a - b)) {
    const wins = ts.filter((t) => t.pnlQuote > 0).length;
    const pnl = ts.reduce((s, t) => s + t.pnlPct, 0);
    result.push({ year, trades: ts.length, winRate: wins / ts.length, pnlPct: pnl });
  }
  return result;
}

function computeVerdict(input: {
  trades: number;
  winRate: number;
  profitFactor: number;
  avgPnlPct: number;
  maxDrawdownPct: number;
  yearByYear: YearMetric[];
  slippageTested: boolean;
}): VerdictResult {
  const redFlags: string[] = [];

  const sampleSize = Math.min(100, (input.trades / 100) * 100);
  if (input.trades < 30) redFlags.push(`only ${input.trades} trades (min 30)`);
  if (input.trades < 100) redFlags.push(`sample below 100 (got ${input.trades})`);

  const expectancy = Math.max(0, Math.min(100, (input.avgPnlPct + 1) * 30));
  if (input.avgPnlPct <= 0) redFlags.push(`negative expectancy: ${input.avgPnlPct.toFixed(2)}%`);

  const riskManagement = Math.max(0, 100 - input.maxDrawdownPct * 5);
  if (input.maxDrawdownPct > 20) redFlags.push(`drawdown ${input.maxDrawdownPct.toFixed(1)}% > 20%`);

  const positiveYears = input.yearByYear.filter((y) => y.pnlPct > 0).length;
  const totalYears = input.yearByYear.length;
  const robustness = totalYears > 0 ? (positiveYears / totalYears) * 100 : 0;
  if (totalYears > 1 && positiveYears / totalYears < 0.5) {
    redFlags.push(`only ${positiveYears}/${totalYears} years positive`);
  }

  const executionRealism = input.slippageTested ? 100 : 40;
  if (!input.slippageTested) redFlags.push('slippage not modeled (set --slippage > 0)');

  if (input.profitFactor < 1) redFlags.push(`profit factor ${input.profitFactor.toFixed(2)} < 1`);
  if (input.winRate > 0.9) redFlags.push(`win rate ${(input.winRate * 100).toFixed(0)}% looks too good (possible look-ahead bias)`);

  const score = (sampleSize + expectancy + riskManagement + robustness + executionRealism) / 5;
  let verdict: Verdict;
  if (score >= 70 && redFlags.length <= 1) verdict = 'DEPLOY';
  else if (score >= 45) verdict = 'REFINE';
  else verdict = 'ABANDON';

  return {
    verdict,
    score,
    dimensions: { sampleSize, expectancy, riskManagement, robustness, executionRealism },
    redFlags,
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

  if (m.yearByYear.length > 0) {
    lines.push('\nYear-by-year:');
    for (const y of m.yearByYear) {
      lines.push(`  ${y.year}: ${y.trades} trades  WR ${(y.winRate * 100).toFixed(1)}%  PnL ${y.pnlPct.toFixed(2)}%`);
    }
  }

  lines.push('\nVerdict:');
  lines.push(`  ${m.verdict.verdict}  (score ${m.verdict.score.toFixed(1)}/100)`);
  lines.push(
    `  Sample: ${m.verdict.dimensions.sampleSize.toFixed(0)}  Expectancy: ${m.verdict.dimensions.expectancy.toFixed(0)}  Risk: ${m.verdict.dimensions.riskManagement.toFixed(0)}  Robust: ${m.verdict.dimensions.robustness.toFixed(0)}  Execution: ${m.verdict.dimensions.executionRealism.toFixed(0)}`,
  );
  if (m.verdict.redFlags.length > 0) {
    lines.push('  Red flags:');
    for (const f of m.verdict.redFlags) lines.push(`    - ${f}`);
  }

  return lines.join('\n');
}
