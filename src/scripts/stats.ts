import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config/config';
import { getDb, closeDb } from '../storage/db';
import { BinancePublicClient } from '../binance/public-client';
import { checkDailyGate } from '../paper/daily-gate';

interface ClosedTrade {
  id: number;
  ts: number;
  closed_ts: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  avg_price: number;
  closed_price: number;
  qty: number;
  quote_qty: number;
  pnl_quote: number;
  pnl_pct: number;
  status: string;
  strategy_name: string;
  tp_pct: number | null;
  sl_pct: number | null;
}

interface OpenTrade {
  id: number;
  ts: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  avg_price: number;
  qty: number;
  strategy_name: string;
}

interface Stats {
  strategyName: string;
  windowStart: number;
  windowEnd: number;
  startingEquity: number;
  closed: ClosedTrade[];
  open: OpenTrade[];
  openPnlQuote: number;
  realizedPnlQuote: number;
  realizedPnlPct: number;
  equityNow: number;
  winRateTotal: number;
  winRateBuy: number;
  winRateSell: number;
  winsBuy: number;
  totalBuy: number;
  winsSell: number;
  totalSell: number;
  maxDdPct: number;
  bestTrade: ClosedTrade | null;
  worstTrade: ClosedTrade | null;
  avgHoldingMinutes: number;
  avgRrRatio: number;
  dailyGateReason: string | null;
  dailyGateDdPct: number;
  dailyGateStreak: number;
  equityCurve: { ts: number; equity: number }[];
}

function parseArgs(argv: string[]): { strategy?: string; since?: number } {
  const out: { strategy?: string; since?: number } = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--strategy' && argv[i + 1]) {
      out.strategy = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--since' && argv[i + 1]) {
      out.since = Date.parse(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

function collectStats(strategy: string | undefined, since: number | undefined): Stats {
  const db = getDb();
  const strategyName = strategy ?? config.trading.strategyName;
  const startingEquity = config.trading.accountEquityUsd;

  const baseSince = since ?? 0;

  const closed = db
    .prepare(
      `SELECT t.id, t.ts, t.closed_ts, t.symbol, t.side, t.avg_price, t.closed_price,
              t.qty, t.quote_qty, t.pnl_quote, t.pnl_pct, t.status, t.strategy_name,
              d.take_profit_pct AS tp_pct, d.stop_loss_pct AS sl_pct
       FROM trades t
       LEFT JOIN decisions d ON d.id = t.decision_id
       WHERE t.mode = 'dryrun'
         AND t.strategy_name = ?
         AND t.status IN ('TP_FILLED','SL_FILLED','CANCELED')
         AND t.closed_ts >= ?
       ORDER BY t.closed_ts ASC`,
    )
    .all(strategyName, baseSince) as ClosedTrade[];

  const openRows = db
    .prepare(
      `SELECT id, ts, symbol, side, avg_price, qty, strategy_name
       FROM trades
       WHERE mode = 'dryrun' AND strategy_name = ? AND status = 'OPEN'`,
    )
    .all(strategyName) as OpenTrade[];

  const realizedPnlQuote = closed.reduce((s, t) => s + (t.pnl_quote ?? 0), 0);
  const realizedPnlPct = (realizedPnlQuote / startingEquity) * 100;

  const buyClosed = closed.filter((t) => t.side === 'BUY');
  const sellClosed = closed.filter((t) => t.side === 'SELL');
  const winsBuy = buyClosed.filter((t) => t.pnl_quote > 0).length;
  const winsSell = sellClosed.filter((t) => t.pnl_quote > 0).length;
  const winsTotal = winsBuy + winsSell;
  const winRateTotal = closed.length > 0 ? winsTotal / closed.length : 0;
  const winRateBuy = buyClosed.length > 0 ? winsBuy / buyClosed.length : 0;
  const winRateSell = sellClosed.length > 0 ? winsSell / sellClosed.length : 0;

  let peak = startingEquity;
  let maxDdPct = 0;
  const equityCurve: { ts: number; equity: number }[] = [
    { ts: closed[0]?.ts ?? Date.now(), equity: startingEquity },
  ];
  let runningEquity = startingEquity;
  for (const t of closed) {
    runningEquity += t.pnl_quote;
    if (runningEquity > peak) peak = runningEquity;
    const dd = ((peak - runningEquity) / peak) * 100;
    if (dd > maxDdPct) maxDdPct = dd;
    equityCurve.push({ ts: t.closed_ts, equity: runningEquity });
  }

  const bestTrade = closed.reduce<ClosedTrade | null>(
    (b, t) => (b === null || t.pnl_quote > b.pnl_quote ? t : b),
    null,
  );
  const worstTrade = closed.reduce<ClosedTrade | null>(
    (w, t) => (w === null || t.pnl_quote < w.pnl_quote ? t : w),
    null,
  );
  const avgHoldingMinutes =
    closed.length > 0
      ? closed.reduce((s, t) => s + (t.closed_ts - t.ts) / 60_000, 0) / closed.length
      : 0;
  const avgRrRatio =
    closed.length > 0
      ? closed.reduce((s, t) => (t.tp_pct && t.sl_pct ? s + t.tp_pct / t.sl_pct : s), 0) /
        closed.length
      : 0;

  const gate = checkDailyGate();

  return {
    strategyName,
    windowStart: closed[0]?.ts ?? Date.now(),
    windowEnd: Date.now(),
    startingEquity,
    closed,
    open: openRows,
    openPnlQuote: 0,
    realizedPnlQuote,
    realizedPnlPct,
    equityNow: startingEquity + realizedPnlQuote,
    winRateTotal,
    winRateBuy,
    winRateSell,
    winsBuy,
    totalBuy: buyClosed.length,
    winsSell,
    totalSell: sellClosed.length,
    maxDdPct,
    bestTrade,
    worstTrade,
    avgHoldingMinutes,
    avgRrRatio,
    dailyGateReason: gate.allowed ? null : gate.reason ?? null,
    dailyGateDdPct: gate.ddPct,
    dailyGateStreak: gate.streak,
    equityCurve,
  };
}

async function addOpenPnl(stats: Stats): Promise<Stats> {
  if (stats.open.length === 0) return stats;
  const pub = new BinancePublicClient();
  const symbols = Array.from(new Set(stats.open.map((t) => t.symbol)));
  const prices: Record<string, number> = {};
  for (const sym of symbols) {
    try {
      prices[sym] = parseFloat((await pub.getPrice(sym)).price);
    } catch {
      prices[sym] = 0;
    }
  }
  let openPnl = 0;
  for (const t of stats.open) {
    const price = prices[t.symbol] ?? t.avg_price;
    const pnl = (t.side === 'BUY' ? price - t.avg_price : t.avg_price - price) * t.qty;
    openPnl += pnl;
  }
  return { ...stats, openPnlQuote: openPnl };
}

function formatUsd(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function formatPct(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

function printCli(stats: Stats): void {
  const ws = new Date(stats.windowStart).toISOString().slice(0, 10);
  const we = new Date(stats.windowEnd).toISOString().slice(0, 10);
  const days = Math.max(1, Math.ceil((stats.windowEnd - stats.windowStart) / 86_400_000));
  console.log(`\nPAPER STATS — ${stats.strategyName}`);
  console.log(`  Window:        ${ws} → ${we} (${days}d)`);
  console.log(
    `  Trades:        ${stats.closed.length + stats.open.length} (open: ${stats.open.length}, closed: ${stats.closed.length})`,
  );
  console.log(
    `  Win rate:      ${(stats.winRateTotal * 100).toFixed(1)}%  (buy: ${(stats.winRateBuy * 100).toFixed(1)}% [${stats.winsBuy}/${stats.totalBuy}]  sell: ${(stats.winRateSell * 100).toFixed(1)}% [${stats.winsSell}/${stats.totalSell}])`,
  );
  console.log(`  Realized PnL:  ${formatUsd(stats.realizedPnlQuote)}  (${formatPct(stats.realizedPnlPct)})`);
  console.log(`  Open PnL:      ${formatUsd(stats.openPnlQuote)}`);
  console.log(`  Equity:        $${stats.equityNow.toFixed(2)}  (start $${stats.startingEquity.toFixed(2)})`);
  console.log(`  Max DD:        -${stats.maxDdPct.toFixed(2)}%`);
  if (stats.bestTrade)
    console.log(
      `  Best trade:    ${formatUsd(stats.bestTrade.pnl_quote)}  (${stats.bestTrade.symbol} ${stats.bestTrade.side})`,
    );
  if (stats.worstTrade)
    console.log(
      `  Worst trade:   ${formatUsd(stats.worstTrade.pnl_quote)}  (${stats.worstTrade.symbol} ${stats.worstTrade.side})`,
    );
  console.log(`  Avg holding:   ${stats.avgHoldingMinutes.toFixed(0)} min`);
  console.log(`  Avg R/R:       ${stats.avgRrRatio.toFixed(2)}`);
  console.log(
    `  Daily gate:    ${stats.dailyGateReason ?? 'OK'} (today: ${stats.dailyGateDdPct.toFixed(2)}% DD, ${stats.dailyGateStreak} streak)`,
  );
  console.log('');
}

function renderHtml(stats: Stats): string {
  const equityJson = JSON.stringify(stats.equityCurve.map((p) => ({ t: p.ts, e: p.equity })));
  const equityDelta = stats.equityNow - stats.startingEquity;
  const equityDeltaPct = (equityDelta / stats.startingEquity) * 100;
  const deltaCls = equityDelta >= 0 ? 'pos' : 'neg';
  const closedRows = [...stats.closed]
    .reverse()
    .map((t) => {
      const cls = t.pnl_quote >= 0 ? 'pos' : 'neg';
      const ts = new Date(t.closed_ts).toISOString().replace('T', ' ').slice(0, 16);
      const holding = ((t.closed_ts - t.ts) / 3_600_000).toFixed(1);
      return `<tr>
        <td>${ts}</td>
        <td>${t.symbol}</td>
        <td>${t.side}</td>
        <td>${t.avg_price.toFixed(2)}</td>
        <td>${t.closed_price.toFixed(2)}</td>
        <td class="${cls}">${formatPct(t.pnl_pct)}</td>
        <td>${t.status}</td>
        <td>${holding}h</td>
        <td>${t.strategy_name}</td>
      </tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Paper stats — ${stats.strategyName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,500;9..144,800&family=JetBrains+Mono:wght@300;500;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0a0a0a;
  --fg: #f5f1e8;
  --dim: #6b6660;
  --pos: #7cff6b;
  --neg: #ff5b5b;
  --rule: #1c1c1c;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--bg); color: var(--fg); font-family: 'Fraunces', serif; font-optical-sizing: auto; }
body { padding: 64px 48px; max-width: 1280px; margin: 0 auto; }
.mono { font-family: 'JetBrains Mono', monospace; font-variant-numeric: tabular-nums; }
.pos { color: var(--pos); } .neg { color: var(--neg); } .dim { color: var(--dim); }
header { display: grid; grid-template-columns: 2fr 1fr; gap: 32px; padding-bottom: 48px; border-bottom: 1px solid var(--rule); }
header .equity { font-family: 'JetBrains Mono', monospace; font-size: 96px; font-weight: 700; letter-spacing: -0.04em; line-height: 1; }
header .label { font-size: 14px; text-transform: uppercase; letter-spacing: 0.2em; color: var(--dim); margin-bottom: 12px; }
header .delta { font-family: 'JetBrains Mono', monospace; font-size: 32px; font-weight: 500; }
header .delta-pct { font-size: 18px; color: var(--dim); margin-top: 4px; }
section.grid { display: grid; grid-template-columns: 2fr 1fr; gap: 48px; padding: 48px 0; border-bottom: 1px solid var(--rule); }
.stat-block { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px 48px; }
.stat-item .stat-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.2em; color: var(--dim); margin-bottom: 6px; }
.stat-item .stat-value { font-family: 'JetBrains Mono', monospace; font-size: 28px; font-weight: 500; }
.right-stack .stat-item { margin-bottom: 28px; }
section.chart { padding: 48px 0; border-bottom: 1px solid var(--rule); }
section.chart h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.2em; color: var(--dim); margin-bottom: 24px; }
canvas { width: 100%; height: 320px; }
section.trades { padding: 48px 0; }
section.trades h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.2em; color: var(--dim); margin-bottom: 24px; }
table { width: 100%; border-collapse: collapse; font-family: 'JetBrains Mono', monospace; font-size: 13px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--rule); font-weight: 400; }
th { color: var(--dim); text-transform: uppercase; letter-spacing: 0.1em; font-size: 11px; }
footer { padding-top: 32px; color: var(--dim); font-family: 'JetBrains Mono', monospace; font-size: 11px; }
.fade { opacity: 0; transform: translateY(8px); animation: fadeUp 0.6s ease-out forwards; }
@keyframes fadeUp { to { opacity: 1; transform: translateY(0); } }
.fade-0 { animation-delay: 0ms; } .fade-1 { animation-delay: 150ms; } .fade-2 { animation-delay: 400ms; } .fade-3 { animation-delay: 600ms; }
</style>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
</head>
<body>
<header class="fade fade-0">
  <div>
    <div class="label">Equity</div>
    <div class="equity" id="equity">$${stats.equityNow.toFixed(2)}</div>
    <div class="dim mono" style="margin-top:12px">strategy: ${stats.strategyName}</div>
  </div>
  <div>
    <div class="label">Δ since start</div>
    <div class="delta mono ${deltaCls}">${formatUsd(equityDelta)}</div>
    <div class="delta-pct mono ${deltaCls}">${formatPct(equityDeltaPct)}</div>
    <div class="label" style="margin-top:24px">Daily gate</div>
    <div class="mono" style="font-size:18px;">${stats.dailyGateReason ?? 'OK'}</div>
  </div>
</header>

<section class="grid fade fade-1">
  <div class="stat-block">
    <div class="stat-item"><div class="stat-label">Trades closed</div><div class="stat-value">${stats.closed.length}</div></div>
    <div class="stat-item"><div class="stat-label">Open</div><div class="stat-value">${stats.open.length}</div></div>
    <div class="stat-item"><div class="stat-label">Win rate</div><div class="stat-value">${(stats.winRateTotal * 100).toFixed(1)}%</div></div>
    <div class="stat-item"><div class="stat-label">Win rate buy</div><div class="stat-value">${(stats.winRateBuy * 100).toFixed(1)}% <span class="dim" style="font-size:14px">${stats.winsBuy}/${stats.totalBuy}</span></div></div>
    <div class="stat-item"><div class="stat-label">Win rate sell</div><div class="stat-value">${(stats.winRateSell * 100).toFixed(1)}% <span class="dim" style="font-size:14px">${stats.winsSell}/${stats.totalSell}</span></div></div>
    <div class="stat-item"><div class="stat-label">Realized PnL</div><div class="stat-value ${stats.realizedPnlQuote >= 0 ? 'pos' : 'neg'}">${formatUsd(stats.realizedPnlQuote)}</div></div>
  </div>
  <div class="right-stack">
    <div class="stat-item"><div class="stat-label">Max drawdown</div><div class="stat-value neg">-${stats.maxDdPct.toFixed(2)}%</div></div>
    <div class="stat-item"><div class="stat-label">Avg holding</div><div class="stat-value">${stats.avgHoldingMinutes.toFixed(0)}m</div></div>
    <div class="stat-item"><div class="stat-label">Avg R/R</div><div class="stat-value">${stats.avgRrRatio.toFixed(2)}</div></div>
    <div class="stat-item"><div class="stat-label">Open PnL</div><div class="stat-value ${stats.openPnlQuote >= 0 ? 'pos' : 'neg'}">${formatUsd(stats.openPnlQuote)}</div></div>
  </div>
</section>

<section class="chart fade fade-2">
  <h2>Equity curve</h2>
  <canvas id="curve"></canvas>
</section>

<section class="trades fade fade-3">
  <h2>Closed trades</h2>
  <table>
    <thead>
      <tr><th>closed</th><th>symbol</th><th>side</th><th>entry</th><th>exit</th><th>pnl %</th><th>outcome</th><th>holding</th><th>strategy</th></tr>
    </thead>
    <tbody>
      ${closedRows}
    </tbody>
  </table>
</section>

<footer>generated ${new Date().toISOString()} · db ${config.storage.dbPath}</footer>

<script>
const data = ${equityJson};
const ctx = document.getElementById('curve').getContext('2d');
new Chart(ctx, {
  type: 'line',
  data: {
    labels: data.map(d => new Date(d.t).toISOString().slice(5, 16).replace('T', ' ')),
    datasets: [{
      data: data.map(d => d.e),
      borderColor: '#f5f1e8',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.18,
      fill: false,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: '#1c1c1c' }, ticks: { color: '#6b6660', font: { family: 'JetBrains Mono', size: 10 } } },
      y: { grid: { color: '#1c1c1c' }, ticks: { color: '#6b6660', font: { family: 'JetBrains Mono', size: 10 } } }
    }
  }
});
</script>
</body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv);
  const raw = collectStats(args.strategy, args.since);
  const stats = await addOpenPnl(raw);

  printCli(stats);

  const outDir = path.dirname(config.storage.dbPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'stats.html');
  fs.writeFileSync(outPath, renderHtml(stats), 'utf-8');
  console.log(`HTML written: ${outPath}\n`);

  closeDb();
}

main().catch((err) => {
  console.error('stats failed:', err);
  process.exit(1);
});
