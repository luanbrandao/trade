import { config } from '../config/config';
import { getDb, closeDb } from '../storage/db';
import { getOpenTrades, TradeRecord } from '../storage/trades';
import { BinancePublicClient } from '../binance/public-client';
import { TradeCloser } from '../postmortem/closer';
import { FillSimulator } from '../paper/fill-simulator';

interface Args {
  intervalSec: number;
  withCandleBackfill: boolean;
  clearScreen: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { intervalSec: 30, withCandleBackfill: true, clearScreen: true };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--interval' && argv[i + 1]) {
      out.intervalSec = Math.max(5, parseInt(argv[i + 1], 10) || 30);
      i += 1;
    } else if (argv[i] === '--no-candle-backfill') {
      out.withCandleBackfill = false;
    } else if (argv[i] === '--no-clear') {
      out.clearScreen = false;
    }
  }
  return out;
}

function fmtUsd(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtPct(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

function unrealizedPnl(trade: TradeRecord, price: number): { pnl: number; pct: number } {
  const isLong = trade.side === 'BUY';
  const pnl = isLong ? (price - trade.avgPrice) * trade.qty : (trade.avgPrice - price) * trade.qty;
  const pct = isLong
    ? ((price - trade.avgPrice) / trade.avgPrice) * 100
    : ((trade.avgPrice - price) / trade.avgPrice) * 100;
  return { pnl, pct };
}

function render(open: TradeRecord[], prices: Record<string, number>, recentClosed: any[], elapsedCycles: number, clearScreen: boolean): void {
  if (clearScreen) process.stdout.write('\x1b[2J\x1b[H');
  else console.log('\n' + '─'.repeat(80));
  const now = new Date().toISOString();
  console.log(`\x1b[1mtrade monitor\x1b[0m  ·  ${now}  ·  cycle ${elapsedCycles}  (Ctrl+C to exit)\n`);

  if (open.length === 0) {
    console.log('  no open trades.\n');
  } else {
    console.log('\x1b[2mOPEN TRADES\x1b[0m');
    console.log(
      '  ' +
        ['id', 'symbol', 'side', 'entry', 'now', 'TP', 'SL', 'qty', 'uPnL', 'uPnL%', 'strategy'].map((h) => h.padEnd(10)).join(' '),
    );
    let totalUnrealized = 0;
    for (const t of open) {
      const price = prices[t.symbol];
      const { pnl, pct } = price != null ? unrealizedPnl(t, price) : { pnl: 0, pct: 0 };
      totalUnrealized += pnl;
      const color = pnl >= 0 ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';
      console.log(
        '  ' +
          [
            `#${t.id}`,
            t.symbol,
            t.side,
            t.avgPrice.toFixed(2),
            price != null ? price.toFixed(2) : '—',
            (t.tpPrice ?? 0).toFixed(2),
            (t.slPrice ?? 0).toFixed(2),
            t.qty.toString(),
            `${color}${fmtUsd(pnl)}${reset}`,
            `${color}${fmtPct(pct)}${reset}`,
            t.strategyName,
          ]
            .map((v, i) => (i === 8 || i === 9 ? v.padEnd(20) : v.padEnd(10)))
            .join(' '),
      );
    }
    console.log(`\n  total unrealized: ${fmtUsd(totalUnrealized)}\n`);
  }

  if (recentClosed.length > 0) {
    console.log('\x1b[2mRECENT CLOSES (last 5)\x1b[0m');
    for (const r of recentClosed.slice(0, 5)) {
      const color = r.pnl_quote >= 0 ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';
      const ts = new Date(r.closed_ts).toISOString().slice(11, 19);
      console.log(
        `  ${ts}  #${r.id}  ${r.symbol} ${r.side}  ${r.status.padEnd(11)}  ${color}${fmtUsd(r.pnl_quote)}  ${fmtPct(r.pnl_pct)}${reset}`,
      );
    }
    console.log();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const pub = new BinancePublicClient();
  const closer = new TradeCloser(pub, null);
  const fillSim = new FillSimulator(pub, closer);

  let cycle = 0;
  let stopped = false;

  process.once('SIGINT', () => {
    stopped = true;
    console.log('\n\nstopping monitor…');
  });

  while (!stopped) {
    cycle += 1;

    // Candle backfill on first tick to catch hits between sessions
    if (args.withCandleBackfill && cycle === 1) {
      try {
        const r = await fillSim.runDryrunFillSim();
        if (r.closed > 0) console.log(`backfill: closed ${r.closed} trades from candle history`);
      } catch (err: any) {
        console.error('backfill error:', err.message);
      }
    }

    // Live-price check every tick
    let liveResult;
    try {
      liveResult = await fillSim.checkLiveAndClose();
    } catch (err: any) {
      console.error('live check error:', err.message);
    }

    const open = getOpenTrades().filter((t) => t.mode === 'dryrun');
    const symbols = Array.from(new Set(open.map((t) => t.symbol)));
    const prices: Record<string, number> = {};
    for (const sym of symbols) {
      try {
        prices[sym] = parseFloat((await pub.getPrice(sym)).price);
      } catch {}
    }

    const recentClosed = getDb()
      .prepare(
        `SELECT id, symbol, side, status, closed_ts, pnl_quote, pnl_pct
         FROM trades
         WHERE mode='dryrun' AND status IN ('TP_FILLED','SL_FILLED','CANCELED')
         ORDER BY closed_ts DESC LIMIT 5`,
      )
      .all();

    render(open, prices, recentClosed, cycle, args.clearScreen);
    if (liveResult && liveResult.closed > 0) {
      console.log(`\x1b[33m  >> live-close fired: ${liveResult.closed} trade(s) closed this tick\x1b[0m\n`);
    }

    // sleep
    await new Promise((r) => setTimeout(r, args.intervalSec * 1000));
  }

  closeDb();
  process.exit(0);
}

main().catch((err) => {
  console.error('monitor failed:', err);
  process.exit(1);
});
