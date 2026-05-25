# Paper Trading Dashboard (Web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-user web dashboard (Node `http`, no framework) that controls (start/stop) the paper-trading loop as a child process and renders live equity, KPIs, open/closed trades, decisions, equity curve, daily-gate status, LLM cost, and a live log tail.

**Architecture:** One systemd unit. `src/dashboard/server.ts` is the parent: it serves a static SPA, exposes a JSON+SSE API, and owns a `LoopController` that spawns/kills `ts-node src/cli.ts dryrun` as a child (forced `TRADE_MODE=dryrun`). The dashboard only **reads** SQLite; the bot child **writes**. `collectStats`/`addOpenPnl` are extracted from `src/scripts/stats.ts` into a shared `src/stats/collect.ts` consumed by both the CLI and the dashboard's `StatsReader`.

**Tech Stack:** TypeScript, Node 20 (`http`, `child_process`, global `fetch` for tests), `better-sqlite3`, `ts-node`, `vitest`. No new runtime dependencies; Chart.js loaded via CDN in the browser.

**Spec reference:** [`docs/superpowers/specs/2026-05-24-dashboard-design.md`](../specs/2026-05-24-dashboard-design.md)

---

## Decisions that deviate from the spec (read first)

1. **LLM cost uses persisted `decisions.llm_cost_usd`, not a re-derived price table.** The spec proposed `SUM(tokens) × hard-coded price table per CLAUDE_MODEL`. Each decision already persists `llm_cost_usd` (computed at decision time from the real provider price). Summing and grouping by `llm_model` is more accurate and avoids a price table that drifts out of date. Tokens are still summed and reported.
2. **No new SIGTERM handler in `src/loop.ts`.** The spec said "if a SIGTERM handler is missing, adding it is part of this work." `TradingLoop.installSignalHandlers()` already handles `SIGTERM`/`SIGINT` (clears the timer, waits for the in-flight cycle, `closeDb()`, `process.exit(0)`). No change needed. The controller's `SIGTERM`→wait-5s→`SIGKILL` sequence is the backstop, so the "<2s finalize" criterion is met for an idle loop and bounded at 5s mid-cycle.
3. **HTTP tests use Node's global `fetch`, not supertest.** Avoids a new dev dependency. Server listens on port `0` (ephemeral) in tests.

---

## File Map

| Path | Action | Purpose |
|------|--------|---------|
| `src/config/config.ts` | Modify | add `dashboard` config object (port/host/pathPrefix/autostartLoop) |
| `.env.example` | Modify | add `DASHBOARD_*` env vars |
| `.gitignore` | Modify | ignore `data/*.pid` |
| `package.json` | Modify | add `dashboard` script |
| `src/stats/collect.ts` | Create | extracted `collectStats` + `addOpenPnl` + shared interfaces |
| `src/scripts/stats.ts` | Modify | import shared collector instead of inline copy |
| `src/dashboard/types.ts` | Create | `DashboardSnapshot`, `LoopStatus`, view types |
| `src/dashboard/binance-prices.ts` | Create | TTL-cached price fetcher (`PriceCache`) |
| `src/dashboard/binance-prices.spec.ts` | Create | unit tests |
| `src/dashboard/llm-cost.ts` | Create | LLM cost/token aggregation from `decisions` |
| `src/dashboard/llm-cost.spec.ts` | Create | unit tests |
| `src/dashboard/stats-reader.ts` | Create | builds `DashboardSnapshot` |
| `src/dashboard/stats-reader.spec.ts` | Create | unit tests (seeded DB) |
| `src/dashboard/loop-controller.ts` | Create | spawn/kill child, PID file, ring buffer, recovery |
| `src/dashboard/loop-controller.spec.ts` | Create | unit tests (fake `/bin/sleep` child) |
| `src/dashboard/index.html` | Create | SPA shell |
| `src/dashboard/styles.css` | Create | editorial styling (Fraunces + JetBrains Mono) |
| `src/dashboard/app.js` | Create | EventSource + fetch + render |
| `src/dashboard/server.ts` | Create | http server, routes, SSE, single-instance guard |
| `src/dashboard/server.spec.ts` | Create | route + SSE tests (fetch) |
| `ops/trade-dashboard.service` | Create | systemd unit |
| `README.md` | Modify | dashboard run + deploy instructions |

---

## Task 1: Add `dashboard` config + env vars

**Files:**
- Modify: `src/config/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add a `boolFromFlag` coercion near the existing `boolFromYesNo`**

Edit `src/config/config.ts`. After the `boolFromYesNo` definition (around line 13-15), add:
```typescript
const boolFromFlag = z
  .string()
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()));
```

- [ ] **Step 2: Add the `dashboard` object to `ConfigSchema`**

In the same file, add a new top-level object to `ConfigSchema` right after the `storage` object (after its closing `}),` around line 64):
```typescript
  dashboard: z.object({
    port: z.coerce.number().int().min(1).max(65535).default(8787),
    host: z.string().default('0.0.0.0'),
    pathPrefix: z.string().default(''),
    autostartLoop: boolFromFlag.default('false'),
  }),
```

- [ ] **Step 3: Wire raw env reads in `loadConfig`**

In the same file, in the `raw` object inside `loadConfig`, add a `dashboard` block right after the `storage` block (after `storage: { dbPath: ... },`):
```typescript
    dashboard: {
      port: process.env.DASHBOARD_PORT,
      host: process.env.DASHBOARD_HOST,
      pathPrefix: process.env.DASHBOARD_PATH_PREFIX,
      autostartLoop: process.env.DASHBOARD_AUTOSTART_LOOP,
    },
```

- [ ] **Step 4: Update `.env.example`**

Edit `.env.example`. Append at the end of the file:
```
# --- Dashboard (paper, single-user) ---
DASHBOARD_PORT=8787              # uncommon port, low collision
DASHBOARD_HOST=0.0.0.0          # use 127.0.0.1 if behind an SSH tunnel
DASHBOARD_PATH_PREFIX=          # optional secret path, e.g. /dash-x7k9q2 (access WITH trailing slash)
DASHBOARD_AUTOSTART_LOOP=false  # if true, dashboard spawns the loop on boot
```

- [ ] **Step 5: Verify config loads**

Run:
```bash
cd /home/luan/test-claude/trade
npx ts-node -e "import { config } from './src/config/config'; console.log(JSON.stringify(config.dashboard));"
```
Expected: `{"port":8787,"host":"0.0.0.0","pathPrefix":"","autostartLoop":false}`

- [ ] **Step 6: Commit**
```bash
git add src/config/config.ts .env.example
git commit -m "feat(config): add dashboard port/host/pathPrefix/autostart env vars"
```

---

## Task 2: Extract shared stats collector → `src/stats/collect.ts`

No behavior change to the `stats` CLI. Move `collectStats`, `addOpenPnl`, and the `ClosedTrade`/`OpenTrade`/`Stats` interfaces into a shared module and re-import them in `stats.ts`.

**Files:**
- Create: `src/stats/collect.ts`
- Modify: `src/scripts/stats.ts`

- [ ] **Step 1: Create `src/stats/collect.ts`**

Create `/home/luan/test-claude/trade/src/stats/collect.ts` with exact contents:
```typescript
import { config } from '../config/config';
import { getDb } from '../storage/db';
import { BinancePublicClient } from '../binance/public-client';
import { checkDailyGate } from '../paper/daily-gate';

export interface ClosedTrade {
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

export interface OpenTrade {
  id: number;
  ts: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  avg_price: number;
  qty: number;
  strategy_name: string;
}

export interface Stats {
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

export function collectStats(strategy: string | undefined, since: number | undefined): Stats {
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

export async function addOpenPnl(stats: Stats): Promise<Stats> {
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
```

- [ ] **Step 2: Replace the moved code in `src/scripts/stats.ts` with an import**

Edit `src/scripts/stats.ts`:

(a) Replace the top import block + the inline interface/function definitions. Delete lines covering the imports of `config`, `getDb/closeDb`, `BinancePublicClient`, `checkDailyGate`, and the `ClosedTrade`, `OpenTrade`, `Stats` interfaces and the `collectStats` and `addOpenPnl` functions (current lines 1-204). Replace that entire span with:
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config/config';
import { closeDb } from '../storage/db';
import { Stats, collectStats, addOpenPnl } from '../stats/collect';
```

(b) Keep everything from `function parseArgs(...)` onward **unchanged** (`parseArgs`, `formatUsd`, `formatPct`, `printCli`, `renderHtml`, `main`, and the final `main().catch(...)`).

> Note: `parseArgs` was previously above `collectStats`; after the edit it now follows the import block. Ensure exactly one `parseArgs` definition remains.

- [ ] **Step 3: Type-check**

Run: `cd /home/luan/test-claude/trade && npx tsc --noEmit`
Expected: no TypeScript errors.

- [ ] **Step 4: Smoke-test the CLI still works (no behavior change)**

Run: `cd /home/luan/test-claude/trade && npm run stats`
Expected: prints the `PAPER STATS — ...` block and `HTML written: ...data/stats.html` exactly as before. (If `data/trade.db` has no trades, it prints zeros — still exits 0.)

- [ ] **Step 5: Run the full test suite (no regressions)**

Run: `npm test`
Expected: existing specs pass.

- [ ] **Step 6: Commit**
```bash
git add src/stats/collect.ts src/scripts/stats.ts
git commit -m "refactor(stats): extract collectStats/addOpenPnl into shared src/stats/collect.ts"
```

---

## Task 3: Dashboard types (the API contract)

**Files:**
- Create: `src/dashboard/types.ts`

- [ ] **Step 1: Create `src/dashboard/types.ts`**

Create `/home/luan/test-claude/trade/src/dashboard/types.ts` with exact contents:
```typescript
export interface LoopStatus {
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  uptimeSec: number;
  lastTickAt: number | null;
  adopted: boolean;
}

export interface DailyGateSnapshot {
  allowed: boolean;
  reason: string | null;
  ddPct: number;
  streak: number;
}

export interface StatsSnapshot {
  strategyName: string;
  windowStart: number;
  windowEnd: number;
  startingEquity: number;
  equityNow: number;
  realizedPnlQuote: number;
  realizedPnlPct: number;
  openPnlQuote: number;
  winRateTotal: number;
  winRateBuy: number;
  winRateSell: number;
  winsBuy: number;
  totalBuy: number;
  winsSell: number;
  totalSell: number;
  maxDdPct: number;
  avgHoldingMinutes: number;
  avgRrRatio: number;
  tradesClosed: number;
  tradesOpen: number;
  dailyGate: DailyGateSnapshot;
}

export interface OpenTradeView {
  id: number;
  ts: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  entry: number;
  currentPrice: number;
  pnlQuote: number;
  pnlPct: number;
  strategyName: string;
}

export interface ClosedTradeView {
  id: number;
  ts: number;
  closedTs: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  entry: number;
  exit: number;
  pnlQuote: number;
  pnlPct: number;
  status: string;
  holdingHours: number;
  strategyName: string;
}

export interface DecisionView {
  ts: number;
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reason: string | null;
  executed: boolean;
  skipReason: string | null;
}

export interface LlmCost {
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  byModel: Record<string, number>;
}

export interface DashboardSnapshot {
  loop: LoopStatus;
  stats: StatsSnapshot;
  openTrades: OpenTradeView[];
  closedTrades: ClosedTradeView[];
  decisions: DecisionView[];
  equityCurve: { ts: number; equity: number }[];
  llmCost: LlmCost;
}

export interface LogLine {
  ts: number;
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface LoopEvent {
  running: boolean;
  reason: string;
}
```

- [ ] **Step 2: Type-check**

Run: `cd /home/luan/test-claude/trade && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**
```bash
git add src/dashboard/types.ts
git commit -m "feat(dashboard): API contract types (DashboardSnapshot et al)"
```

---

## Task 4: `binance-prices.ts` — TTL-cached price fetcher (TDD)

**Files:**
- Create: `src/dashboard/binance-prices.spec.ts`
- Create: `src/dashboard/binance-prices.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/binance-prices.spec.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { PriceCache } from './binance-prices';

class FakePub {
  calls = 0;
  prices: Record<string, string>;
  constructor(prices: Record<string, string>) {
    this.prices = prices;
  }
  async getPrice(symbol: string): Promise<{ symbol: string; price: string }> {
    this.calls += 1;
    return { symbol, price: this.prices[symbol] ?? '0' };
  }
}

describe('PriceCache', () => {
  it('fetches prices and parses to number', async () => {
    const pub = new FakePub({ BTCUSDT: '67500.5' });
    const cache = new PriceCache(pub, 15_000, () => 1000);
    const out = await cache.getPrices(['BTCUSDT']);
    expect(out.BTCUSDT).toBe(67500.5);
    expect(pub.calls).toBe(1);
  });

  it('serves from cache within TTL (no refetch)', async () => {
    const pub = new FakePub({ BTCUSDT: '100' });
    let now = 1000;
    const cache = new PriceCache(pub, 15_000, () => now);
    await cache.getPrices(['BTCUSDT']);
    now = 1000 + 14_000;
    await cache.getPrices(['BTCUSDT']);
    expect(pub.calls).toBe(1);
  });

  it('refetches after TTL expires', async () => {
    const pub = new FakePub({ BTCUSDT: '100' });
    let now = 1000;
    const cache = new PriceCache(pub, 15_000, () => now);
    await cache.getPrices(['BTCUSDT']);
    now = 1000 + 16_000;
    await cache.getPrices(['BTCUSDT']);
    expect(pub.calls).toBe(2);
  });

  it('fetches a newly requested symbol even within TTL', async () => {
    const pub = new FakePub({ BTCUSDT: '100', ETHUSDT: '3000' });
    const cache = new PriceCache(pub, 15_000, () => 1000);
    await cache.getPrices(['BTCUSDT']);
    const out = await cache.getPrices(['BTCUSDT', 'ETHUSDT']);
    expect(out.ETHUSDT).toBe(3000);
  });

  it('returns empty object for empty input without fetching', async () => {
    const pub = new FakePub({});
    const cache = new PriceCache(pub, 15_000, () => 1000);
    const out = await cache.getPrices([]);
    expect(out).toEqual({});
    expect(pub.calls).toBe(0);
  });

  it('keeps prior cached value if a fetch throws', async () => {
    const pub = new FakePub({ BTCUSDT: '100' });
    let now = 1000;
    const cache = new PriceCache(pub, 15_000, () => now);
    await cache.getPrices(['BTCUSDT']);
    pub.getPrice = async () => {
      throw new Error('network');
    };
    now = 1000 + 16_000;
    const out = await cache.getPrices(['BTCUSDT']);
    expect(out.BTCUSDT).toBe(100);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- src/dashboard/binance-prices.spec.ts`
Expected: FAIL — module `./binance-prices` not found.

- [ ] **Step 3: Implement `binance-prices.ts`**

Create `src/dashboard/binance-prices.ts`:
```typescript
import { BinancePublicClient } from '../binance/public-client';

export interface PriceSource {
  getPrice(symbol: string): Promise<{ symbol: string; price: string }>;
}

const DEFAULT_TTL_MS = 15_000;

export class PriceCache {
  private cache = new Map<string, number>();
  private fetchedAt = 0;

  constructor(
    private pub: PriceSource = new BinancePublicClient(),
    private ttlMs: number = DEFAULT_TTL_MS,
    private now: () => number = () => Date.now(),
  ) {}

  async getPrices(symbols: string[]): Promise<Record<string, number>> {
    if (symbols.length === 0) return {};

    const fresh = this.now() - this.fetchedAt < this.ttlMs;
    const hasAll = symbols.every((s) => this.cache.has(s));

    if (!fresh || !hasAll) {
      for (const sym of symbols) {
        try {
          const t = await this.pub.getPrice(sym);
          this.cache.set(sym, parseFloat(t.price));
        } catch {
          // keep any prior cached value; otherwise this symbol is simply omitted
        }
      }
      this.fetchedAt = this.now();
    }

    const out: Record<string, number> = {};
    for (const s of symbols) {
      const v = this.cache.get(s);
      if (v != null) out[s] = v;
    }
    return out;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/dashboard/binance-prices.spec.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**
```bash
git add src/dashboard/binance-prices.ts src/dashboard/binance-prices.spec.ts
git commit -m "feat(dashboard): TTL-cached Binance price fetcher"
```

---

## Task 5: `llm-cost.ts` — cost/token aggregation (TDD)

**Files:**
- Create: `src/dashboard/llm-cost.spec.ts`
- Create: `src/dashboard/llm-cost.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/llm-cost.spec.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./data/test-llm-cost.db');
process.env.DB_PATH = TEST_DB;

import { getDb, closeDb } from '../storage/db';
import { insertDecision, DecisionRecord } from '../storage/decisions';
import { collectLlmCost } from './llm-cost';

function resetDb() {
  closeDb();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  getDb();
}

function makeDecision(over: Partial<DecisionRecord>): DecisionRecord {
  return {
    ts: Date.now(),
    symbol: 'BTCUSDT',
    action: 'HOLD',
    confidence: 50,
    reason: 'x',
    stopLossPct: null,
    takeProfitPct: null,
    timeHorizonMinutes: null,
    priceAtDecision: 60000,
    llmModel: 'claude-opus-4-7',
    llmInputTokens: 1000,
    llmOutputTokens: 100,
    llmCostUsd: 0.01,
    executed: false,
    skipReason: null,
    mode: 'dryrun',
    strategyName: 'test',
    ...over,
  };
}

describe('collectLlmCost', () => {
  beforeEach(() => resetDb());

  it('returns zeros when no decisions', () => {
    const c = collectLlmCost('test');
    expect(c.totalUsd).toBe(0);
    expect(c.inputTokens).toBe(0);
    expect(c.outputTokens).toBe(0);
    expect(c.byModel).toEqual({});
  });

  it('sums cost and tokens for the strategy', () => {
    insertDecision(makeDecision({ llmCostUsd: 0.01, llmInputTokens: 1000, llmOutputTokens: 100 }));
    insertDecision(makeDecision({ llmCostUsd: 0.02, llmInputTokens: 500, llmOutputTokens: 50 }));
    const c = collectLlmCost('test');
    expect(c.totalUsd).toBeCloseTo(0.03, 6);
    expect(c.inputTokens).toBe(1500);
    expect(c.outputTokens).toBe(150);
    expect(c.byModel['claude-opus-4-7']).toBeCloseTo(0.03, 6);
  });

  it('breaks cost down by model', () => {
    insertDecision(makeDecision({ llmModel: 'claude-opus-4-7', llmCostUsd: 0.01 }));
    insertDecision(makeDecision({ llmModel: 'gpt-4o-mini', llmCostUsd: 0.002 }));
    const c = collectLlmCost('test');
    expect(c.byModel['claude-opus-4-7']).toBeCloseTo(0.01, 6);
    expect(c.byModel['gpt-4o-mini']).toBeCloseTo(0.002, 6);
  });

  it('ignores decisions from other strategies', () => {
    insertDecision(makeDecision({ strategyName: 'other', llmCostUsd: 5 }));
    const c = collectLlmCost('test');
    expect(c.totalUsd).toBe(0);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- src/dashboard/llm-cost.spec.ts`
Expected: FAIL — module `./llm-cost` not found.

- [ ] **Step 3: Implement `llm-cost.ts`**

Create `src/dashboard/llm-cost.ts`:
```typescript
import { getDb } from '../storage/db';
import { LlmCost } from './types';

export function collectLlmCost(strategyName: string): LlmCost {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT llm_model AS model,
              COALESCE(SUM(llm_input_tokens), 0) AS input_tokens,
              COALESCE(SUM(llm_output_tokens), 0) AS output_tokens,
              COALESCE(SUM(llm_cost_usd), 0) AS cost_usd
       FROM decisions
       WHERE strategy_name = ? AND mode = 'dryrun'
       GROUP BY llm_model`,
    )
    .all(strategyName) as {
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }[];

  const byModel: Record<string, number> = {};
  let totalUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const r of rows) {
    const model = r.model ?? 'unknown';
    byModel[model] = (byModel[model] ?? 0) + r.cost_usd;
    totalUsd += r.cost_usd;
    inputTokens += r.input_tokens;
    outputTokens += r.output_tokens;
  }

  return { totalUsd, inputTokens, outputTokens, byModel };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/dashboard/llm-cost.spec.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**
```bash
git add src/dashboard/llm-cost.ts src/dashboard/llm-cost.spec.ts
git commit -m "feat(dashboard): LLM cost aggregation from persisted decision costs"
```

---

## Task 6: `stats-reader.ts` — build the `DashboardSnapshot` (TDD)

**Files:**
- Create: `src/dashboard/stats-reader.spec.ts`
- Create: `src/dashboard/stats-reader.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/stats-reader.spec.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./data/test-stats-reader.db');
process.env.DB_PATH = TEST_DB;
process.env.STRATEGY_NAME = 'reader_test';
process.env.ACCOUNT_EQUITY_USD = '1000';

import { getDb, closeDb } from '../storage/db';
import { insertTrade, TradeRecord } from '../storage/trades';
import { insertDecision, DecisionRecord } from '../storage/decisions';
import { StatsReader } from './stats-reader';
import { PriceCache } from './binance-prices';
import { LoopStatus } from './types';

const STRAT = 'reader_test';

function resetDb() {
  closeDb();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  getDb();
}

function closedTrade(over: Partial<TradeRecord>): TradeRecord {
  return {
    decisionId: null,
    ts: 1_000_000,
    symbol: 'BTCUSDT',
    side: 'BUY',
    qty: 0.001,
    avgPrice: 60000,
    quoteQty: 60,
    binanceOrderId: 'SIM-c',
    ocoOrderListId: null,
    tpPrice: 61200,
    slPrice: 59400,
    status: 'TP_FILLED',
    closedTs: 2_000_000,
    closedPrice: 61200,
    pnlQuote: 1.2,
    pnlPct: 2.0,
    mode: 'dryrun',
    strategyName: STRAT,
    ...over,
  };
}

function openTrade(over: Partial<TradeRecord>): TradeRecord {
  return {
    decisionId: null,
    ts: 3_000_000,
    symbol: 'ETHUSDT',
    side: 'BUY',
    qty: 0.01,
    avgPrice: 3000,
    quoteQty: 30,
    binanceOrderId: 'SIM-o',
    ocoOrderListId: null,
    tpPrice: 3100,
    slPrice: 2900,
    status: 'OPEN',
    closedTs: null,
    closedPrice: null,
    pnlQuote: null,
    pnlPct: null,
    mode: 'dryrun',
    strategyName: STRAT,
    ...over,
  };
}

function decision(over: Partial<DecisionRecord>): DecisionRecord {
  return {
    ts: 1_500_000,
    symbol: 'BTCUSDT',
    action: 'BUY',
    confidence: 80,
    reason: 'r',
    stopLossPct: 1,
    takeProfitPct: 2,
    timeHorizonMinutes: 60,
    priceAtDecision: 60000,
    llmModel: 'claude-opus-4-7',
    llmInputTokens: 1000,
    llmOutputTokens: 100,
    llmCostUsd: 0.01,
    executed: true,
    skipReason: null,
    mode: 'dryrun',
    strategyName: STRAT,
    ...over,
  };
}

class FakePub {
  async getPrice(symbol: string) {
    return { symbol, price: '3050' }; // ETH up 50 from 3000 entry
  }
}

function loopStub(): LoopStatus {
  return { running: false, pid: null, startedAt: null, uptimeSec: 0, lastTickAt: null, adopted: false };
}

describe('StatsReader.snapshot', () => {
  beforeEach(() => resetDb());

  it('builds KPIs, open PnL, decisions, and llm cost', async () => {
    insertTrade(closedTrade({ side: 'BUY', pnlQuote: 1.2, pnlPct: 2.0, status: 'TP_FILLED' }));
    insertTrade(closedTrade({ side: 'SELL', pnlQuote: -0.6, pnlPct: -1.0, status: 'SL_FILLED', binanceOrderId: 'SIM-c2' }));
    insertTrade(openTrade({}));
    insertDecision(decision({}));

    const reader = new StatsReader(new PriceCache(new FakePub(), 15_000, () => 0));
    const snap = await reader.snapshot(loopStub());

    expect(snap.stats.tradesClosed).toBe(2);
    expect(snap.stats.tradesOpen).toBe(1);
    expect(snap.stats.winsBuy).toBe(1);
    expect(snap.stats.totalBuy).toBe(1);
    expect(snap.stats.winsSell).toBe(0);
    expect(snap.stats.totalSell).toBe(1);
    expect(snap.stats.winRateTotal).toBeCloseTo(0.5, 6);
    expect(snap.stats.realizedPnlQuote).toBeCloseTo(0.6, 6);
    expect(snap.stats.equityNow).toBeCloseTo(1000.6, 6);

    // open ETH: (3050 - 3000) * 0.01 = 0.5
    expect(snap.openTrades).toHaveLength(1);
    expect(snap.openTrades[0].currentPrice).toBe(3050);
    expect(snap.openTrades[0].pnlQuote).toBeCloseTo(0.5, 6);
    expect(snap.stats.openPnlQuote).toBeCloseTo(0.5, 6);

    expect(snap.closedTrades).toHaveLength(2);
    expect(snap.decisions).toHaveLength(1);
    expect(snap.decisions[0].action).toBe('BUY');

    expect(snap.llmCost.totalUsd).toBeCloseTo(0.01, 6);
    expect(snap.stats.dailyGate.allowed).toBe(true);
    expect(snap.loop.lastTickAt).toBe(1_500_000); // MAX(decisions.ts)
  });

  it('returns empty arrays and zeros for an empty DB', async () => {
    const reader = new StatsReader(new PriceCache(new FakePub(), 15_000, () => 0));
    const snap = await reader.snapshot(loopStub());
    expect(snap.stats.tradesClosed).toBe(0);
    expect(snap.openTrades).toEqual([]);
    expect(snap.closedTrades).toEqual([]);
    expect(snap.decisions).toEqual([]);
    expect(snap.loop.lastTickAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- src/dashboard/stats-reader.spec.ts`
Expected: FAIL — module `./stats-reader` not found.

- [ ] **Step 3: Implement `stats-reader.ts`**

Create `src/dashboard/stats-reader.ts`:
```typescript
import { config } from '../config/config';
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
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/dashboard/stats-reader.spec.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**
```bash
git add src/dashboard/stats-reader.ts src/dashboard/stats-reader.spec.ts
git commit -m "feat(dashboard): StatsReader builds DashboardSnapshot from SQLite"
```

---

## Task 7: `loop-controller.ts` — spawn/kill child + PID file + ring buffer (TDD)

**Files:**
- Create: `src/dashboard/loop-controller.spec.ts`
- Create: `src/dashboard/loop-controller.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/loop-controller.spec.ts`:
```typescript
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { LoopController } from './loop-controller';

function tmpPid(): string {
  return path.join(os.tmpdir(), `loop-test-${process.pid}-${Math.random().toString(36).slice(2)}.pid`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
});

describe('LoopController', () => {
  it('start() spawns a child and writes the PID file', async () => {
    const pidFile = tmpPid();
    const ctrl = new LoopController({ command: '/bin/sleep', args: ['5'], pidFile });
    cleanups.push(() => { try { ctrl.stop(); } catch {} });

    const r = ctrl.start();
    expect(r.ok).toBe(true);
    expect(typeof r.pid).toBe('number');
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(ctrl.isRunning()).toBe(true);
  });

  it('start() while running returns already-running', async () => {
    const pidFile = tmpPid();
    const ctrl = new LoopController({ command: '/bin/sleep', args: ['5'], pidFile });
    cleanups.push(() => { try { ctrl.stop(); } catch {} });
    ctrl.start();
    const r = ctrl.start();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('already running');
  });

  it('stop() kills the child and removes the PID file', async () => {
    const pidFile = tmpPid();
    const ctrl = new LoopController({ command: '/bin/sleep', args: ['30'], pidFile });
    ctrl.start();
    await ctrl.stop();
    expect(ctrl.isRunning()).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('adopts a live PID from the PID file on construction', async () => {
    const pidFile = tmpPid();
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    fs.writeFileSync(pidFile, String(child.pid));
    cleanups.push(() => { try { child.kill('SIGKILL'); } catch {} });

    const ctrl = new LoopController({ command: '/bin/sleep', args: ['30'], pidFile });
    const status = ctrl.status();
    expect(status.running).toBe(true);
    expect(status.adopted).toBe(true);
    expect(status.pid).toBe(child.pid);
  });

  it('cleans a stale PID file on construction', async () => {
    const pidFile = tmpPid();
    fs.writeFileSync(pidFile, '999999'); // assume not a live PID
    const ctrl = new LoopController({ command: '/bin/sleep', args: ['1'], pidFile });
    expect(ctrl.isRunning()).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('captures child stdout into the ring buffer', async () => {
    const pidFile = tmpPid();
    const ctrl = new LoopController({
      command: '/bin/sh',
      args: ['-c', 'echo hello-from-child; sleep 5'],
      pidFile,
    });
    cleanups.push(() => { try { ctrl.stop(); } catch {} });
    ctrl.start();
    await sleep(300);
    const logs = ctrl.logs(50);
    expect(logs.some((l) => l.line.includes('hello-from-child'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- src/dashboard/loop-controller.spec.ts`
Expected: FAIL — module `./loop-controller` not found.

- [ ] **Step 3: Implement `loop-controller.ts`**

Create `src/dashboard/loop-controller.ts`:
```typescript
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { LoopStatus, LogLine } from './types';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PID_FILE = path.join(PROJECT_ROOT, 'data', 'loop.pid');
const DEFAULT_ARGS = [require.resolve('ts-node/dist/bin'), 'src/cli.ts', 'dryrun'];
const RING_MAX = 500;

export interface LoopControllerOpts {
  command?: string;
  args?: string[];
  pidFile?: string;
}

export class LoopController extends EventEmitter {
  private command: string;
  private args: string[];
  private pidFile: string;
  private child: ChildProcess | null = null;
  private startedAt: number | null = null;
  private adoptedPid: number | null = null;
  private ring: LogLine[] = [];

  constructor(opts: LoopControllerOpts = {}) {
    super();
    this.command = opts.command ?? process.execPath;
    this.args = opts.args ?? DEFAULT_ARGS;
    this.pidFile = opts.pidFile ?? DEFAULT_PID_FILE;
    this.recoverFromPidFile();
  }

  isRunning(): boolean {
    if (this.child && this.child.exitCode === null && !this.child.killed) return true;
    if (this.adoptedPid != null) {
      try {
        process.kill(this.adoptedPid, 0);
        return true;
      } catch {
        this.adoptedPid = null;
        this.clearPidFile();
        return false;
      }
    }
    return false;
  }

  status(): LoopStatus {
    const running = this.isRunning();
    const pid = this.child?.pid ?? this.adoptedPid ?? null;
    const startedAt = running ? this.startedAt : null;
    return {
      running,
      pid: running ? pid : null,
      startedAt,
      uptimeSec: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
      lastTickAt: null, // filled in by StatsReader
      adopted: running && this.child === null && this.adoptedPid != null,
    };
  }

  start(): { ok: boolean; pid?: number; reason?: string } {
    if (this.isRunning()) return { ok: false, reason: 'already running' };
    try {
      const child = spawn(this.command, this.args, {
        cwd: PROJECT_ROOT,
        env: { ...process.env, TRADE_MODE: 'dryrun' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      this.child = child;
      this.adoptedPid = null;
      this.startedAt = Date.now();
      this.ensureDataDir();
      fs.writeFileSync(this.pidFile, String(child.pid));

      child.stdout?.on('data', (c: Buffer) => this.push('stdout', c.toString()));
      child.stderr?.on('data', (c: Buffer) => this.push('stderr', c.toString()));
      child.on('exit', (code, sig) => {
        this.clearPidFile();
        this.child = null;
        this.startedAt = null;
        this.emit('loop', { running: false, reason: `exited code=${code ?? '?'} sig=${sig ?? '-'}` });
      });

      this.emit('loop', { running: true, reason: 'spawned' });
      return { ok: true, pid: child.pid };
    } catch (err: any) {
      return { ok: false, reason: err.message };
    }
  }

  async stop(): Promise<{ ok: boolean }> {
    const pid = this.child?.pid ?? this.adoptedPid;
    if (!this.isRunning() || pid == null) {
      this.clearPidFile();
      return { ok: true };
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    const exited = await this.waitForDead(pid, 5000);
    if (!exited) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      await this.waitForDead(pid, 2000);
    }
    this.child = null;
    this.adoptedPid = null;
    this.startedAt = null;
    this.clearPidFile();
    return { ok: true };
  }

  logs(n = 200): LogLine[] {
    return this.ring.slice(-Math.min(n, RING_MAX));
  }

  private push(stream: 'stdout' | 'stderr', chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) continue;
      const entry: LogLine = { ts: Date.now(), stream, line };
      this.ring.push(entry);
      if (this.ring.length > RING_MAX) this.ring.shift();
      this.emit('log', entry);
    }
  }

  private recoverFromPidFile(): void {
    if (!fs.existsSync(this.pidFile)) return;
    const raw = fs.readFileSync(this.pidFile, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (!Number.isInteger(pid)) {
      this.clearPidFile();
      return;
    }
    try {
      process.kill(pid, 0);
      this.adoptedPid = pid;
      this.startedAt = fs.statSync(this.pidFile).mtimeMs;
    } catch {
      this.clearPidFile();
    }
  }

  private ensureDataDir(): void {
    const dir = path.dirname(this.pidFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private clearPidFile(): void {
    try {
      if (fs.existsSync(this.pidFile)) fs.unlinkSync(this.pidFile);
    } catch {
      /* ignore */
    }
  }

  private waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = setInterval(() => {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        if (!alive) {
          clearInterval(tick);
          resolve(true);
        } else if (Date.now() - start >= timeoutMs) {
          clearInterval(tick);
          resolve(false);
        }
      }, 100);
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/dashboard/loop-controller.spec.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**
```bash
git add src/dashboard/loop-controller.ts src/dashboard/loop-controller.spec.ts
git commit -m "feat(dashboard): LoopController — spawn/kill child, PID file, ring buffer, recovery"
```

---

## Task 8: Frontend static files (`index.html`, `styles.css`, `app.js`)

These are served as-is by `server.ts` (Task 9). The `frontend-design` skill may polish typography/spacing during execution; the files below are complete and functional.

**Files:**
- Create: `src/dashboard/index.html`
- Create: `src/dashboard/styles.css`
- Create: `src/dashboard/app.js`

- [ ] **Step 1: Create `src/dashboard/index.html`**

Create `src/dashboard/index.html` with exact contents:
```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TRADE · paper</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,500;9..144,800&family=JetBrains+Mono:wght@300;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="styles.css" />
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
</head>
<body>
<div id="adopted-banner" class="banner hidden">
  Loop adopted from PID file. Logs unavailable until restart. STOP still works.
</div>

<header class="control-bar">
  <div class="brand">TRADE <span class="dim">· paper</span></div>
  <div class="control-right">
    <span id="loop-state" class="loop-state"><span class="dot dot-gray"></span><span id="loop-label">…</span></span>
    <span id="control-action">
      <button id="btn-start" class="btn hidden">START</button>
      <button id="btn-stop" class="btn btn-danger hidden">STOP</button>
      <span id="stop-confirm" class="hidden">Confirm? <button id="btn-stop-yes" class="btn btn-danger">yes</button> <button id="btn-stop-cancel" class="btn">cancel</button></span>
    </span>
  </div>
</header>

<main>
  <section class="equity-row">
    <div>
      <div class="label">Equity</div>
      <div id="equity" class="equity mono">—</div>
      <div id="strategy" class="dim mono"></div>
    </div>
    <div>
      <div class="label">Δ since start</div>
      <div id="delta" class="delta mono">—</div>
      <div id="delta-pct" class="delta-pct mono"></div>
      <div class="label" style="margin-top:20px">Daily gate</div>
      <div id="daily-gate" class="mono">—</div>
    </div>
  </section>

  <section class="kpi-grid" id="kpi-grid"></section>

  <section class="chart">
    <h2>Equity curve</h2>
    <canvas id="curve"></canvas>
  </section>

  <section class="block">
    <h2>Open positions</h2>
    <table><thead><tr>
      <th>symbol</th><th>side</th><th>qty</th><th>entry</th><th>now</th><th>uPnL</th><th>uPnL %</th>
    </tr></thead><tbody id="open-rows"></tbody></table>
  </section>

  <section class="block">
    <h2>Recent decisions</h2>
    <table><thead><tr>
      <th>time</th><th>symbol</th><th>action</th><th>conf</th><th>exec</th><th>reason / skip</th>
    </tr></thead><tbody id="decision-rows"></tbody></table>
  </section>

  <section class="block">
    <h2>Closed trades</h2>
    <table><thead><tr>
      <th>closed</th><th>symbol</th><th>side</th><th>entry</th><th>exit</th><th>pnl %</th><th>outcome</th><th>holding</th>
    </tr></thead><tbody id="closed-rows"></tbody></table>
  </section>
</main>

<div id="log-drawer" class="log-drawer collapsed">
  <button id="log-toggle" class="log-toggle">▣ logs</button>
  <pre id="log-body" class="log-body"></pre>
</div>

<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `src/dashboard/styles.css`**

Create `src/dashboard/styles.css` with exact contents:
```css
:root {
  --bg: #0a0a0a;
  --fg: #f5f1e8;
  --dim: #6b6660;
  --pos: #7cff6b;
  --neg: #ff5b5b;
  --rule: #1c1c1c;
  --warn: #e8c95b;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--bg); color: var(--fg); font-family: 'Fraunces', serif; font-optical-sizing: auto; }
body { min-width: 720px; }
.mono { font-family: 'JetBrains Mono', monospace; font-variant-numeric: tabular-nums; }
.dim { color: var(--dim); }
.pos { color: var(--pos); }
.neg { color: var(--neg); }
.hidden { display: none !important; }

.banner { background: var(--warn); color: #0a0a0a; font-family: 'JetBrains Mono', monospace; font-size: 13px; padding: 10px 24px; text-align: center; }

.control-bar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 32px; background: rgba(10,10,10,0.92); backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--rule);
}
.brand { font-weight: 800; font-size: 20px; letter-spacing: -0.01em; }
.control-right { display: flex; align-items: center; gap: 20px; }
.loop-state { font-family: 'JetBrains Mono', monospace; font-size: 13px; display: inline-flex; align-items: center; gap: 8px; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.dot-green { background: var(--pos); box-shadow: 0 0 8px var(--pos); }
.dot-gray { background: var(--dim); }
.dot-red { background: var(--neg); box-shadow: 0 0 8px var(--neg); }
.btn { font-family: 'JetBrains Mono', monospace; font-size: 12px; letter-spacing: 0.1em; background: transparent; color: var(--fg); border: 1px solid var(--rule); padding: 7px 16px; cursor: pointer; border-radius: 3px; }
.btn:hover { border-color: var(--fg); }
.btn-danger { color: var(--neg); border-color: var(--neg); }
.btn-danger:hover { background: var(--neg); color: #0a0a0a; }

main { max-width: 1280px; margin: 0 auto; padding: 48px 32px; }
.label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.2em; color: var(--dim); margin-bottom: 8px; }
.equity-row { display: grid; grid-template-columns: 2fr 1fr; gap: 32px; padding-bottom: 40px; border-bottom: 1px solid var(--rule); }
.equity { font-size: 84px; font-weight: 700; letter-spacing: -0.04em; line-height: 1; }
.delta { font-size: 30px; font-weight: 500; }
.delta-pct { font-size: 16px; color: var(--dim); margin-top: 4px; }

.kpi-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 24px 32px; padding: 40px 0; border-bottom: 1px solid var(--rule); }
.kpi .kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.18em; color: var(--dim); margin-bottom: 6px; }
.kpi .kpi-value { font-family: 'JetBrains Mono', monospace; font-size: 24px; font-weight: 500; }
.kpi .kpi-sub { font-size: 12px; color: var(--dim); }

.chart, .block { padding: 40px 0; border-bottom: 1px solid var(--rule); }
.chart h2, .block h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.2em; color: var(--dim); margin-bottom: 20px; }
canvas { width: 100%; height: 300px; }

table { width: 100%; border-collapse: collapse; font-family: 'JetBrains Mono', monospace; font-size: 13px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--rule); font-weight: 400; }
th { color: var(--dim); text-transform: uppercase; letter-spacing: 0.1em; font-size: 11px; }
td.empty { color: var(--dim); padding: 16px 12px; }

.log-drawer { position: fixed; right: 24px; bottom: 24px; width: 560px; max-width: calc(100vw - 48px); background: #0d0d0d; border: 1px solid var(--rule); border-radius: 6px; z-index: 20; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
.log-drawer.collapsed .log-body { display: none; }
.log-toggle { width: 100%; text-align: left; font-family: 'JetBrains Mono', monospace; font-size: 12px; background: transparent; color: var(--fg); border: none; padding: 10px 14px; cursor: pointer; }
.log-body { height: 280px; overflow-y: auto; font-family: 'JetBrains Mono', monospace; font-size: 11.5px; line-height: 1.5; padding: 0 14px 12px; color: var(--dim); white-space: pre-wrap; word-break: break-all; }
.log-body .err { color: var(--neg); }
```

- [ ] **Step 3: Create `src/dashboard/app.js`**

Create `src/dashboard/app.js` with exact contents:
```javascript
'use strict';

// Resolve API base from the page location so an optional path prefix works
// (access the dashboard WITH a trailing slash when using a prefix).
const BASE = location.pathname.replace(/\/[^/]*$/, '');
const api = (p) => `${BASE}${p}`;

const $ = (id) => document.getElementById(id);

let chart = null;
let autoTail = true;

function fmtUsd(v) {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}
function fmtPct(v) {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}
function fmtClock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function tsShort(ms) {
  return new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
}
function cls(v) {
  return v >= 0 ? 'pos' : 'neg';
}

function renderLoop(loop) {
  const dot = $('loop-state').querySelector('.dot');
  const label = $('loop-label');
  $('btn-start').classList.add('hidden');
  $('btn-stop').classList.add('hidden');
  $('stop-confirm').classList.add('hidden');
  $('adopted-banner').classList.toggle('hidden', !loop.adopted);

  if (loop.running) {
    dot.className = 'dot dot-green';
    label.textContent = `running ${fmtClock(loop.uptimeSec)}`;
    $('btn-stop').classList.remove('hidden');
  } else {
    dot.className = 'dot dot-gray';
    label.textContent = 'stopped';
    $('btn-start').classList.remove('hidden');
  }
}

function kpi(label, value, sub, valueCls) {
  return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value ${valueCls || ''}">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
}

function renderStats(s, llm) {
  $('equity').textContent = `$${s.equityNow.toFixed(2)}`;
  $('strategy').textContent = `strategy: ${s.strategyName}`;
  const delta = s.equityNow - s.startingEquity;
  $('delta').textContent = fmtUsd(delta);
  $('delta').className = `delta mono ${cls(delta)}`;
  $('delta-pct').textContent = fmtPct(s.realizedPnlPct);
  $('daily-gate').textContent = s.dailyGate.allowed
    ? `OK (DD ${s.dailyGate.ddPct.toFixed(2)}%, streak ${s.dailyGate.streak})`
    : s.dailyGate.reason || 'BLOCKED';
  $('daily-gate').className = s.dailyGate.allowed ? 'mono pos' : 'mono neg';

  $('kpi-grid').innerHTML = [
    kpi('Trades closed', s.tradesClosed),
    kpi('Open', s.tradesOpen),
    kpi('Win rate', `${(s.winRateTotal * 100).toFixed(1)}%`),
    kpi('Win rate buy', `${(s.winRateBuy * 100).toFixed(1)}%`, `${s.winsBuy}/${s.totalBuy}`),
    kpi('Win rate sell', `${(s.winRateSell * 100).toFixed(1)}%`, `${s.winsSell}/${s.totalSell}`),
    kpi('Max DD', `-${s.maxDdPct.toFixed(2)}%`, '', 'neg'),
    kpi('Avg holding', `${s.avgHoldingMinutes.toFixed(0)}m`),
    kpi('Avg R/R', s.avgRrRatio.toFixed(2)),
    kpi('Open PnL', fmtUsd(s.openPnlQuote), '', cls(s.openPnlQuote)),
    kpi('LLM cost', `$${llm.totalUsd.toFixed(4)}`, `${(llm.inputTokens / 1000).toFixed(0)}k in / ${(llm.outputTokens / 1000).toFixed(1)}k out`),
  ].join('');
}

function renderOpen(rows) {
  const body = $('open-rows');
  if (!rows.length) {
    body.innerHTML = '<tr><td class="empty" colspan="7">no open positions</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map(
      (t) => `<tr>
      <td>${t.symbol}</td><td>${t.side}</td><td>${t.qty}</td>
      <td>${t.entry.toFixed(2)}</td><td>${t.currentPrice.toFixed(2)}</td>
      <td class="${cls(t.pnlQuote)}">${fmtUsd(t.pnlQuote)}</td>
      <td class="${cls(t.pnlPct)}">${fmtPct(t.pnlPct)}</td></tr>`,
    )
    .join('');
}

function renderDecisions(rows) {
  const body = $('decision-rows');
  if (!rows.length) {
    body.innerHTML = '<tr><td class="empty" colspan="6">no decisions yet</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map(
      (d) => `<tr>
      <td>${tsShort(d.ts)}</td><td>${d.symbol}</td><td>${d.action}</td>
      <td>${d.confidence}%</td><td>${d.executed ? 'EXEC' : 'skip'}</td>
      <td class="dim">${(d.skipReason || d.reason || '').slice(0, 60)}</td></tr>`,
    )
    .join('');
}

function renderClosed(rows) {
  const body = $('closed-rows');
  if (!rows.length) {
    body.innerHTML = '<tr><td class="empty" colspan="8">no closed trades</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map(
      (t) => `<tr>
      <td>${tsShort(t.closedTs)}</td><td>${t.symbol}</td><td>${t.side}</td>
      <td>${t.entry.toFixed(2)}</td><td>${t.exit.toFixed(2)}</td>
      <td class="${cls(t.pnlPct)}">${fmtPct(t.pnlPct)}</td>
      <td>${t.status}</td><td>${t.holdingHours.toFixed(1)}h</td></tr>`,
    )
    .join('');
}

function renderChart(curve) {
  const labels = curve.map((p) => tsShort(p.ts));
  const data = curve.map((p) => p.equity);
  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.update('none');
    return;
  }
  const ctx = $('curve').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ data, borderColor: '#f5f1e8', borderWidth: 1.5, pointRadius: 0, tension: 0.18, fill: false }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#1c1c1c' }, ticks: { color: '#6b6660', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 8 } },
        y: { grid: { color: '#1c1c1c' }, ticks: { color: '#6b6660', font: { family: 'JetBrains Mono', size: 10 } } },
      },
    },
  });
}

function render(snap) {
  renderLoop(snap.loop);
  renderStats(snap.stats, snap.llmCost);
  renderOpen(snap.openTrades);
  renderDecisions(snap.decisions);
  renderClosed(snap.closedTrades);
  renderChart(snap.equityCurve);
}

function appendLog(entry) {
  const body = $('log-body');
  const span = document.createElement('span');
  span.className = entry.stream === 'stderr' ? 'err' : '';
  span.textContent = `${new Date(entry.ts).toISOString().slice(11, 19)}  ${entry.line}\n`;
  body.appendChild(span);
  while (body.childNodes.length > 800) body.removeChild(body.firstChild);
  if (autoTail) body.scrollTop = body.scrollHeight;
}

// --- controls ---
$('btn-start').addEventListener('click', async () => {
  await fetch(api('/api/start'), { method: 'POST' });
});
$('btn-stop').addEventListener('click', () => {
  $('btn-stop').classList.add('hidden');
  $('stop-confirm').classList.remove('hidden');
  setTimeout(() => {
    $('stop-confirm').classList.add('hidden');
    $('btn-stop').classList.remove('hidden');
  }, 5000);
});
$('btn-stop-yes').addEventListener('click', async () => {
  await fetch(api('/api/stop'), { method: 'POST' });
});
$('btn-stop-cancel').addEventListener('click', () => {
  $('stop-confirm').classList.add('hidden');
  $('btn-stop').classList.remove('hidden');
});

// --- log drawer ---
$('log-toggle').addEventListener('click', () => {
  $('log-drawer').classList.toggle('collapsed');
});
$('log-body').addEventListener('scroll', () => {
  const b = $('log-body');
  autoTail = b.scrollTop + b.clientHeight >= b.scrollHeight - 20;
});

// --- cold load of recent logs ---
fetch(api('/api/logs?n=200'))
  .then((r) => r.json())
  .then((lines) => lines.forEach(appendLog))
  .catch(() => {});

// --- live stream ---
const es = new EventSource(api('/api/stream'));
es.addEventListener('snapshot', (e) => render(JSON.parse(e.data)));
es.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
es.addEventListener('loop', () => {
  // a status flip will arrive via the next snapshot; force an immediate refresh
  fetch(api('/api/status')).then((r) => r.json()).then(render).catch(() => {});
});
```

- [ ] **Step 4: Sanity-check the files exist and are non-empty**

Run: `wc -l src/dashboard/index.html src/dashboard/styles.css src/dashboard/app.js`
Expected: three files, each with a non-trivial line count.

- [ ] **Step 5: Commit**
```bash
git add src/dashboard/index.html src/dashboard/styles.css src/dashboard/app.js
git commit -m "feat(dashboard): static SPA (control bar, KPIs, chart, tables, log drawer)"
```

---

## Task 9: `server.ts` — http routes + SSE + single-instance guard (TDD)

**Files:**
- Create: `src/dashboard/server.spec.ts`
- Create: `src/dashboard/server.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/server.spec.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { AddressInfo } from 'net';

const TEST_DB = path.resolve('./data/test-server.db');
process.env.DB_PATH = TEST_DB;
process.env.STRATEGY_NAME = 'server_test';
process.env.ACCOUNT_EQUITY_USD = '1000';

import { getDb, closeDb } from '../storage/db';
import { insertTrade, TradeRecord } from '../storage/trades';
import { createServer } from './server';
import { LoopController } from './loop-controller';
import { StatsReader } from './stats-reader';
import { PriceCache } from './binance-prices';

let server: http.Server;
let base: string;
let pidFile: string;

class FakePub {
  async getPrice(symbol: string) {
    return { symbol, price: '0' };
  }
}

function seed() {
  closeDb();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  getDb();
  const t: TradeRecord = {
    decisionId: null, ts: 1_000_000, symbol: 'BTCUSDT', side: 'BUY', qty: 0.001,
    avgPrice: 60000, quoteQty: 60, binanceOrderId: 'SIM-1', ocoOrderListId: null,
    tpPrice: 61200, slPrice: 59400, status: 'TP_FILLED', closedTs: 2_000_000,
    closedPrice: 61200, pnlQuote: 1.2, pnlPct: 2.0, mode: 'dryrun', strategyName: 'server_test',
  };
  insertTrade(t);
}

beforeAll(async () => {
  seed();
  pidFile = path.join(os.tmpdir(), `server-test-${process.pid}.pid`);
  const controller = new LoopController({ command: '/bin/sleep', args: ['30'], pidFile });
  const reader = new StatsReader(new PriceCache(new FakePub(), 15_000, () => 0));
  server = createServer(controller, reader);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch {}
});

describe('dashboard server', () => {
  it('GET /api/status returns a snapshot', async () => {
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stats.tradesClosed).toBe(1);
    expect(body.loop.running).toBe(false);
    expect(Array.isArray(body.closedTrades)).toBe(true);
  });

  it('GET / serves the HTML shell', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('TRADE');
  });

  it('POST /api/start then /api/stop flips running state', async () => {
    const start = await fetch(`${base}/api/start`, { method: 'POST' });
    expect(start.status).toBe(200);
    expect((await start.json()).ok).toBe(true);

    const running = await (await fetch(`${base}/api/status`)).json();
    expect(running.loop.running).toBe(true);

    const dup = await fetch(`${base}/api/start`, { method: 'POST' });
    expect(dup.status).toBe(409);

    const stop = await fetch(`${base}/api/stop`, { method: 'POST' });
    expect(stop.status).toBe(200);

    const stopped = await (await fetch(`${base}/api/status`)).json();
    expect(stopped.loop.running).toBe(false);
  });

  it('GET /api/stream opens an SSE channel', async () => {
    const res = await fetch(`${base}/api/stream`, { headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk.length).toBeGreaterThan(0); // keepalive ':' or an event frame
    await reader.cancel();
  });

  it('GET /api/logs returns an array', async () => {
    const res = await fetch(`${base}/api/logs?n=10`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- src/dashboard/server.spec.ts`
Expected: FAIL — module `./server` not found.

- [ ] **Step 3: Implement `server.ts`**

Create `src/dashboard/server.ts`:
```typescript
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config/config';
import { log } from '../logger';
import { LoopController } from './loop-controller';
import { StatsReader } from './stats-reader';
import { LogLine, LoopEvent } from './types';

const STATIC_DIR = __dirname;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DASHBOARD_PID = path.join(PROJECT_ROOT, 'data', 'dashboard.pid');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function createServer(controller: LoopController, reader: StatsReader): http.Server {
  const prefix = config.dashboard.pathPrefix;
  const sseClients = new Set<http.ServerResponse>();

  controller.on('log', (entry: LogLine) => broadcast('log', entry));
  controller.on('loop', (evt: LoopEvent) => broadcast('loop', evt));

  function broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function buildSnapshot() {
    return reader.snapshot(controller.status());
  }

  function json(res: http.ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function serveStatic(name: string, res: http.ServerResponse): void {
    const file = path.join(STATIC_DIR, name);
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] ?? 'application/octet-stream' });
      res.end(buf);
    });
  }

  function handleStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(':\n\n');
    sseClients.add(res);

    const sendSnapshot = () => {
      buildSnapshot()
        .then((snap) => res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`))
        .catch((err) => log.error('snapshot for SSE failed', { err: err.message }));
    };
    sendSnapshot();
    const snapTimer = setInterval(sendSnapshot, 15_000);
    const keepalive = setInterval(() => {
      try {
        res.write(':\n\n');
      } catch {
        /* closed */
      }
    }, 20_000);

    req.on('close', () => {
      clearInterval(snapTimer);
      clearInterval(keepalive);
      sseClients.delete(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname = url.pathname;
      if (prefix && pathname.startsWith(prefix)) {
        pathname = pathname.slice(prefix.length) || '/';
      }

      if (req.method === 'GET' && pathname === '/') return serveStatic('index.html', res);
      if (req.method === 'GET' && (pathname === '/app.js' || pathname === '/styles.css')) {
        return serveStatic(pathname.slice(1), res);
      }
      if (req.method === 'GET' && pathname === '/api/status') {
        return json(res, 200, await buildSnapshot());
      }
      if (req.method === 'POST' && pathname === '/api/start') {
        const r = controller.start();
        const code = r.ok ? 200 : r.reason === 'already running' ? 409 : 500;
        return json(res, code, r);
      }
      if (req.method === 'POST' && pathname === '/api/stop') {
        return json(res, 200, await controller.stop());
      }
      if (req.method === 'GET' && pathname === '/api/logs') {
        const n = parseInt(url.searchParams.get('n') ?? '200', 10) || 200;
        return json(res, 200, controller.logs(n));
      }
      if (req.method === 'GET' && pathname === '/api/stream') {
        return handleStream(req, res);
      }

      res.writeHead(404);
      res.end('not found');
    } catch (err: any) {
      log.error('dashboard request failed', { err: err.message });
      try {
        json(res, 500, { ok: false, reason: err.message });
      } catch {
        /* headers already sent */
      }
    }
  });

  return server;
}

function singleInstanceGuard(): void {
  if (fs.existsSync(DASHBOARD_PID)) {
    const pid = parseInt(fs.readFileSync(DASHBOARD_PID, 'utf8').trim(), 10);
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid, 0);
        console.error(`Dashboard already running (pid ${pid}). Exiting.`);
        process.exit(1);
      } catch {
        /* stale pid file — fall through and overwrite */
      }
    }
  }
  const dir = path.dirname(DASHBOARD_PID);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DASHBOARD_PID, String(process.pid));
}

if (require.main === module) {
  singleInstanceGuard();
  const controller = new LoopController();
  const reader = new StatsReader();
  if (config.dashboard.autostartLoop) controller.start();

  const server = createServer(controller, reader);
  server.listen(config.dashboard.port, config.dashboard.host, () => {
    log.info('Dashboard listening', {
      host: config.dashboard.host,
      port: config.dashboard.port,
      prefix: config.dashboard.pathPrefix || '(none)',
    });
  });

  const shutdown = () => {
    try {
      if (fs.existsSync(DASHBOARD_PID)) fs.unlinkSync(DASHBOARD_PID);
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/dashboard/server.spec.ts`
Expected: 5 passing.

- [ ] **Step 5: Type-check the whole project**

Run: `cd /home/luan/test-claude/trade && npx tsc --noEmit`
Expected: no TypeScript errors.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all specs pass (existing + binance-prices + llm-cost + stats-reader + loop-controller + server).

- [ ] **Step 7: Commit**
```bash
git add src/dashboard/server.ts src/dashboard/server.spec.ts
git commit -m "feat(dashboard): http server — routes, SSE, single-instance guard"
```

---

## Task 10: Wiring — npm script, `.gitignore`, systemd unit, README

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `ops/trade-dashboard.service`
- Modify: `README.md`

- [ ] **Step 1: Add the `dashboard` npm script**

Edit `package.json`. In `scripts`, add this line right after the `"stats": ...` line:
```json
    "dashboard": "ts-node src/dashboard/server.ts",
```

- [ ] **Step 2: Ignore PID files**

Edit `.gitignore`. Append:
```
data/*.pid
```

- [ ] **Step 3: Create the systemd unit**

Create `ops/trade-dashboard.service` with exact contents:
```ini
[Unit]
Description=Trade dashboard (paper, single-user)
After=network.target

[Service]
Type=simple
User=trade
WorkingDirectory=/opt/trade
EnvironmentFile=/opt/trade/.env
ExecStart=/usr/bin/node node_modules/ts-node/dist/bin.js src/dashboard/server.ts
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/trade/data /opt/trade/logs

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: Document the dashboard in README**

Edit `README.md`. Add a new section (place it after the existing run/usage section; if unsure, append before the final section). Insert:
```markdown
## Paper-trading dashboard (web)

A single-user web dashboard to start/stop the dryrun loop and watch live stats.

```bash
npm run dashboard        # serves on http://localhost:8787
```

Environment (all optional, see `.env.example`):

- `DASHBOARD_PORT` (default `8787`)
- `DASHBOARD_HOST` (default `0.0.0.0`; use `127.0.0.1` behind an SSH tunnel)
- `DASHBOARD_PATH_PREFIX` (optional secret path, e.g. `/dash-x7k9q2` — access **with a trailing slash**: `http://host:8787/dash-x7k9q2/`)
- `DASHBOARD_AUTOSTART_LOOP` (default `false`)

Security: no auth. The dashboard only starts/stops a **dryrun** loop (no money movement). On a VPS, restrict access:

```bash
sudo ufw allow from <home-ip> to any port 8787
# or bind 127.0.0.1 and tunnel:  ssh -L 8787:localhost:8787 vps
```

### Deploy (systemd)

```bash
sudo systemctl disable --now trade.service        # if previously installed
sudo cp ops/trade-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trade-dashboard.service
# access: http://<vps-ip>:8787
```
```

- [ ] **Step 5: Type-check (script-only changes don't affect TS, but confirm nothing broke)**

Run: `cd /home/luan/test-claude/trade && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**
```bash
git add package.json .gitignore ops/trade-dashboard.service README.md
git commit -m "chore(dashboard): npm script, gitignore pids, systemd unit, README"
```

---

## Task 11: Manual end-to-end verification (acceptance criteria)

**Files:** none (verification only).

- [ ] **Step 1: Boot the dashboard**

Run: `cd /home/luan/test-claude/trade && npm run dashboard`
Expected: logs `Dashboard listening { host: '0.0.0.0', port: 8787, prefix: '(none)' }`. Leave it running in one terminal.

- [ ] **Step 2: Render check**

Open `http://localhost:8787` in a browser.
Expected: control bar shows a gray dot + `stopped` + a `START` button; KPI grid, equity curve, and tables render (empty-state rows are fine on a fresh DB).

- [ ] **Step 3: START spawns the loop, logs flow**

Click `START`.
Expected: dot turns green, label shows `running 0m`, `STOP` button appears. Open the `▣ logs` drawer (bottom-right) — within ~15s the child's startup lines stream in (`Trading loop starting`, `Cycle start`, etc.).

- [ ] **Step 4: Status reflects running loop via API**

Run (second terminal): `curl -s localhost:8787/api/status | head -c 400`
Expected: JSON with `"loop":{"running":true,...}` and a numeric `pid`.

- [ ] **Step 5: STOP terminates within 5s**

Click `STOP`, then `yes`.
Expected: within 5s the dot returns to gray, label `stopped`, `START` reappears. `ls data/loop.pid` → file is gone.

- [ ] **Step 6: Reload preserves adopted state**

Click `START` again. With the loop running, kill the dashboard process (Ctrl+C in terminal 1), then re-run `npm run dashboard`.
Expected: on load the yellow banner "Loop adopted from PID file…" shows, dot is green. Clicking `STOP` then `yes` still terminates the loop (signals match by user). Then stop the dashboard.

- [ ] **Step 7: Confirm the suite is green**

Run: `npm test`
Expected: all specs pass.

- [ ] **Step 8: Final type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

> Acceptance criteria mapping (from the spec):
> - `npm run dashboard` boots on :8787 → Step 1
> - `http://localhost:8787` renders → Step 2
> - START spawns child, status flips, logs flow → Steps 3-4
> - STOP terminates within 5s → Step 5
> - Reload preserves state / adopts PID → Step 6
> - 24h no-leak (ring buffer capped at 500) → enforced in `LoopController.push` (`RING_MAX`); not separately exercised here.
> - SIGTERM to child finalizes fast → handled by existing `TradingLoop` signal handler + controller SIGKILL backstop (Decision #2).

---

## Self-review notes

- **Spec coverage:** routes (`/`, `/api/status`, `/api/stream`, `/api/start`, `/api/stop`, `/api/logs`) → Task 9; LoopController spawn/kill/PID/ring/recovery/single-instance → Tasks 7 & 9; StatsReader snapshot shape → Task 6; shared collector extraction → Task 2; binance price cache → Task 4; llm cost → Task 5; frontend layout (control bar, KPI grid, equity curve, open/decisions/closed, log drawer, adopted banner, STOP confirm) → Task 8; env vars → Task 1; npm script + systemd + README → Task 10; tests (loop-controller, stats-reader, server) → Tasks 6, 7, 9. Two spec items intentionally adjusted — see "Decisions" at top.
- **Type consistency:** `DashboardSnapshot`/`LoopStatus`/`LogLine`/`LoopEvent` defined in Task 3 and consumed unchanged in Tasks 6, 7, 9. `PriceSource.getPrice` returns `{ symbol, price }` matching `PriceTicker` usage. `collectStats`/`addOpenPnl`/`Stats` signatures preserved from the original `stats.ts`.
```
