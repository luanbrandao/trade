# MVP Paper Trading + Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add paper-trading capability with real TP/SL fill simulator, daily-loss gate, strategy-name tagging, and an HTML stats dashboard, all as a minimal patch onto the existing `dryrun` mode.

**Architecture:** Patch the existing `dryrun` pipeline. New modules under `src/paper/` (daily-gate, fill-simulator). Refactor `src/postmortem/closer.ts` to expose `persistClose` publicly so the fill-simulator can reuse close logic. Add `strategy_name` columns to `trades` and `decisions` via idempotent SQL migration. New script `src/scripts/stats.ts` reads SQLite and renders both a CLI summary and a styled `data/stats.html` (Chart.js via CDN, distinctive typography per `frontend-design` skill).

**Tech Stack:** TypeScript, Node 20, `better-sqlite3`, `axios`, `zod`, `ts-node`. New devDep: `vitest` (minimal test runner) + `@vitest/expect`.

**Spec reference:** [`docs/superpowers/specs/2026-05-19-mvp-paper-trading-dashboard-design.md`](../specs/2026-05-19-mvp-paper-trading-dashboard-design.md)

---

## File Map

| Path | Action | Purpose |
|------|--------|---------|
| `package.json` | Modify | add `vitest`, `stats`, `test` scripts |
| `vitest.config.ts` | Create | minimal config for ts-native vitest |
| `.env.example` | Modify | add new env vars |
| `.gitignore` | Modify | ignore `data/stats.html` |
| `src/config/config.ts` | Modify | add `strategyName`, `maxDailyLossPct`, `maxDailyLosses`, `dryrunMaxHoldHours` |
| `src/storage/db.ts` | Modify | add idempotent ALTER TABLE migrations for `strategy_name` |
| `src/storage/trades.ts` | Modify | add `strategyName` to `TradeRecord` + insert SQL |
| `src/storage/decisions.ts` | Modify | add `strategyName` to `DecisionRecord` + insert SQL |
| `src/postmortem/closer.ts` | Modify | expose `persistClose` as public method, remove `runDryrunTimeout`/`tryCloseDryrunTimeout` |
| `src/paper/daily-gate.ts` | Create | daily loss gate (DD% or streak) |
| `src/paper/daily-gate.spec.ts` | Create | unit tests |
| `src/paper/fill-simulator.ts` | Create | TP/SL hit detection via 15m candles |
| `src/paper/fill-simulator.spec.ts` | Create | unit tests |
| `src/strategy/orchestrator.ts` | Modify | call daily gate before pipeline; pass `strategyName` into decision insert; use FillSimulator instead of timeout closer |
| `src/executor/trade-executor.ts` | Modify | populate `strategyName` in `TradeRecord` |
| `src/scripts/stats.ts` | Create | CLI stats + HTML generator |

---

## Task 1: Add vitest and test wiring

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install vitest as dev dependency**

Run:
```bash
cd /home/luan/test-claude/trade
npm install --save-dev vitest@^2.0.0
```

Expected: vitest added to `devDependencies` in `package.json`.

- [ ] **Step 2: Create `vitest.config.ts`**

Create `/home/luan/test-claude/trade/vitest.config.ts` with exact contents:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 3: Add `test` script to `package.json`**

Edit `package.json` `scripts` section. Add a new line right after the existing `"build": "tsc",` line:
```json
"test": "vitest run",
```

- [ ] **Step 4: Verify vitest runs (no tests yet → exits 0)**

Run: `npm test`
Expected: vitest reports "No test files found" and exits with code 0 (or near-zero). Output should contain "Test Files  0 passed". If it exits 1 because of "no tests found", that's also acceptable — we'll add tests next.

- [ ] **Step 5: Commit**

```bash
cd /home/luan/test-claude/trade
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest for unit tests"
```

---

## Task 2: Config schema additions

**Files:**
- Modify: `src/config/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add new fields to the `ConfigSchema` `trading` object**

Edit `src/config/config.ts`. Locate the `trading` zod object (around line 27-41). Add these fields at the end of the trading object, before the closing `})`:
```typescript
    strategyName: z.string().min(1).default('ema9_21+claude_v1'),
    maxDailyLossPct: z.coerce.number().min(0).max(100).default(3.0),
    maxDailyLosses: z.coerce.number().int().min(1).default(3),
    dryrunMaxHoldHours: z.coerce.number().min(1).default(168),
```

So the trading object now ends with:
```typescript
    loopIntervalMinutes: z.coerce.number().min(1).default(15),
    understandRisks: boolFromYesNo.default('no'),
    strategyName: z.string().min(1).default('ema9_21+claude_v1'),
    maxDailyLossPct: z.coerce.number().min(0).max(100).default(3.0),
    maxDailyLosses: z.coerce.number().int().min(1).default(3),
    dryrunMaxHoldHours: z.coerce.number().min(1).default(168),
  }),
```

- [ ] **Step 2: Wire raw env reads in `loadConfig`**

Inside `loadConfig` in the same file, locate the `trading` block of `raw`. Add at the end of that block (just before `},`):
```typescript
      strategyName: process.env.STRATEGY_NAME,
      maxDailyLossPct: process.env.MAX_DAILY_LOSS_PCT,
      maxDailyLosses: process.env.MAX_DAILY_LOSSES,
      dryrunMaxHoldHours: process.env.DRYRUN_MAX_HOLD_HOURS,
```

- [ ] **Step 3: Update `.env.example`**

Edit `.env.example`. After the line `COOLDOWN_MINUTES=30                # min minutes between trades on same symbol`, add:
```
STRATEGY_NAME=ema9_21+claude_v1    # tag persisted on trades/decisions for cross-strategy comparison
MAX_DAILY_LOSS_PCT=3.0             # paper-trading daily drawdown cap (% of accountEquity)
MAX_DAILY_LOSSES=3                 # consecutive-loss streak cap per UTC day
DRYRUN_MAX_HOLD_HOURS=168          # timeout for dryrun trades that never hit TP/SL (7d)
```

- [ ] **Step 4: Verify config loads (no runtime crash)**

Run: `npx ts-node -e "import { config } from './src/config/config'; console.log(JSON.stringify({strategy: config.trading.strategyName, ddPct: config.trading.maxDailyLossPct, losses: config.trading.maxDailyLosses, maxHold: config.trading.dryrunMaxHoldHours}));"`

Expected: `{"strategy":"ema9_21+claude_v1","ddPct":3,"losses":3,"maxHold":168}`

- [ ] **Step 5: Commit**

```bash
git add src/config/config.ts .env.example
git commit -m "feat(config): add strategyName + daily-gate + dryrun max-hold env vars"
```

---

## Task 3: Idempotent migration for `strategy_name` columns

**Files:**
- Modify: `src/storage/db.ts`

- [ ] **Step 1: Add migration helper for ALTER TABLE if-not-exists**

Edit `src/storage/db.ts`. After the `MIGRATIONS` array literal (line 71), add a helper function and integrate it into `getDb`. Replace the existing `for (const sql of MIGRATIONS) { db.exec(sql); }` loop with the following block (inside `getDb`):

```typescript
  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }

  addColumnIfMissing(db, 'trades', 'strategy_name', "TEXT NOT NULL DEFAULT 'unknown'");
  addColumnIfMissing(db, 'decisions', 'strategy_name', "TEXT NOT NULL DEFAULT 'unknown'");
```

Then add this helper at the bottom of the file (after `closeDb`):

```typescript
function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
```

- [ ] **Step 2: Verify migration is idempotent**

Run:
```bash
cd /home/luan/test-claude/trade
rm -f data/trade.db
npx ts-node -e "import { getDb, closeDb } from './src/storage/db'; const db = getDb(); console.log(db.prepare('PRAGMA table_info(trades)').all().map((c: any) => c.name).join(',')); closeDb();"
```

Expected: output contains `strategy_name` in the column list.

Then run the same command **a second time** to confirm no error and the column is still present (no duplicate ADD).

- [ ] **Step 3: Verify against an existing DB (if any)**

If the user has an existing `data/trade.db` from prior runs, run the same one-liner against it: `npx ts-node -e "import { getDb, closeDb } from './src/storage/db'; const db = getDb(); console.log(db.prepare('PRAGMA table_info(decisions)').all().map((c: any) => c.name).join(',')); closeDb();"`

Expected: `strategy_name` appears in the column list. No data loss.

- [ ] **Step 4: Commit**

```bash
git add src/storage/db.ts
git commit -m "feat(db): idempotent migration for strategy_name on trades+decisions"
```

---

## Task 4: Plumb `strategyName` through trade + decision records (TDD)

**Files:**
- Modify: `src/storage/trades.ts`
- Modify: `src/storage/decisions.ts`
- Modify: `src/executor/trade-executor.ts`
- Modify: `src/strategy/orchestrator.ts`
- Create: `src/storage/strategy-name.spec.ts`

- [ ] **Step 1: Write failing test**

Create `src/storage/strategy-name.spec.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./data/test-strategy.db');
process.env.DB_PATH = TEST_DB;

import { getDb, closeDb } from './db';
import { insertTrade, TradeRecord } from './trades';
import { insertDecision, DecisionRecord } from './decisions';

function resetDb() {
  closeDb();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  getDb();
}

describe('strategy_name persistence', () => {
  beforeEach(() => resetDb());

  it('persists strategyName on inserted trade', () => {
    const decision: DecisionRecord = {
      ts: Date.now(),
      symbol: 'BTCUSDT',
      action: 'BUY',
      confidence: 80,
      reason: 'test',
      stopLossPct: 1,
      takeProfitPct: 2,
      timeHorizonMinutes: 60,
      priceAtDecision: 60000,
      llmModel: 'test',
      llmInputTokens: 0,
      llmOutputTokens: 0,
      llmCostUsd: 0,
      executed: false,
      skipReason: null,
      mode: 'dryrun',
      strategyName: 'ema9_21+claude_v1',
    };
    const decisionId = insertDecision(decision);

    const trade: TradeRecord = {
      decisionId,
      ts: Date.now(),
      symbol: 'BTCUSDT',
      side: 'BUY',
      qty: 0.001,
      avgPrice: 60000,
      quoteQty: 60,
      binanceOrderId: 'SIM-1',
      ocoOrderListId: null,
      tpPrice: 61200,
      slPrice: 59400,
      status: 'OPEN',
      closedTs: null,
      closedPrice: null,
      pnlQuote: null,
      pnlPct: null,
      mode: 'dryrun',
      strategyName: 'ema9_21+claude_v1',
    };
    const tradeId = insertTrade(trade);

    const db = getDb();
    const tradeRow = db.prepare('SELECT strategy_name FROM trades WHERE id = ?').get(tradeId) as { strategy_name: string };
    const decRow = db.prepare('SELECT strategy_name FROM decisions WHERE id = ?').get(decisionId) as { strategy_name: string };
    expect(tradeRow.strategy_name).toBe('ema9_21+claude_v1');
    expect(decRow.strategy_name).toBe('ema9_21+claude_v1');
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- src/storage/strategy-name.spec.ts`
Expected: FAIL (TypeScript error: `strategyName` not in `TradeRecord` or `DecisionRecord`).

- [ ] **Step 3: Update `TradeRecord` type and insert SQL**

Edit `src/storage/trades.ts`.

Change the `TradeRecord` interface — add `strategyName: string;` right after `mode`:
```typescript
export interface TradeRecord {
  id?: number;
  decisionId: number | null;
  ts: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  avgPrice: number;
  quoteQty: number;
  binanceOrderId: string;
  ocoOrderListId: string | null;
  tpPrice: number | null;
  slPrice: number | null;
  status: TradeStatus;
  closedTs: number | null;
  closedPrice: number | null;
  pnlQuote: number | null;
  pnlPct: number | null;
  mode: 'dryrun' | 'live' | 'backtest';
  strategyName: string;
}
```

Update the `insertTrade` SQL — add `strategy_name` to the columns list and `@strategyName` to the values:
```typescript
export function insertTrade(t: TradeRecord): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO trades (
      decision_id, ts, symbol, side, qty, avg_price, quote_qty,
      binance_order_id, oco_order_list_id, tp_price, sl_price,
      status, closed_ts, closed_price, pnl_quote, pnl_pct, mode, strategy_name
    ) VALUES (
      @decisionId, @ts, @symbol, @side, @qty, @avgPrice, @quoteQty,
      @binanceOrderId, @ocoOrderListId, @tpPrice, @slPrice,
      @status, @closedTs, @closedPrice, @pnlQuote, @pnlPct, @mode, @strategyName
    )
  `);
  const result = stmt.run(t);
  return Number(result.lastInsertRowid);
}
```

- [ ] **Step 4: Update `DecisionRecord` type and insert SQL**

Edit `src/storage/decisions.ts`.

Add `strategyName: string;` to `DecisionRecord` after `mode`:
```typescript
export interface DecisionRecord {
  ts: number;
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reason: string | null;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  timeHorizonMinutes: number | null;
  priceAtDecision: number;
  llmModel: string;
  llmInputTokens: number | null;
  llmOutputTokens: number | null;
  llmCostUsd: number | null;
  executed: boolean;
  skipReason: string | null;
  mode: 'dryrun' | 'live' | 'backtest';
  strategyName: string;
}
```

Update `insertDecision` SQL:
```typescript
export function insertDecision(d: DecisionRecord): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO decisions (
      ts, symbol, action, confidence, reason,
      stop_loss_pct, take_profit_pct, time_horizon_minutes,
      price_at_decision, llm_model, llm_input_tokens, llm_output_tokens, llm_cost_usd,
      executed, skip_reason, mode, strategy_name
    ) VALUES (
      @ts, @symbol, @action, @confidence, @reason,
      @stopLossPct, @takeProfitPct, @timeHorizonMinutes,
      @priceAtDecision, @llmModel, @llmInputTokens, @llmOutputTokens, @llmCostUsd,
      @executed, @skipReason, @mode, @strategyName
    )
  `);
  const result = stmt.run({ ...d, executed: d.executed ? 1 : 0 });
  return Number(result.lastInsertRowid);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/storage/strategy-name.spec.ts`
Expected: PASS.

- [ ] **Step 6: Wire `strategyName` into call sites — `trade-executor.ts`**

Edit `src/executor/trade-executor.ts`. Both `executeSimulated` and `executeLive` build a `TradeRecord`. Add `strategyName: config.trading.strategyName` to the record literal in both methods.

In `executeSimulated` (around line 103-121), the `record` literal must end with:
```typescript
    const record: TradeRecord = {
      decisionId,
      ts: Date.now(),
      symbol,
      side,
      qty,
      avgPrice: currentPrice,
      quoteQty,
      binanceOrderId: `SIM-${Date.now()}`,
      ocoOrderListId: null,
      tpPrice,
      slPrice,
      status: 'OPEN' as TradeStatus,
      closedTs: null,
      closedPrice: null,
      pnlQuote: null,
      pnlPct: null,
      mode,
      strategyName: config.trading.strategyName,
    };
```

In `executeLive` (around line 204-222), same final field on the record literal:
```typescript
    const record: TradeRecord = {
      decisionId,
      ts: Date.now(),
      symbol,
      side,
      qty: executedQty,
      avgPrice: fillPrice,
      quoteQty: parseFloat(order.cummulativeQuoteQty),
      binanceOrderId: String(order.orderId),
      ocoOrderListId,
      tpPrice: risk.takeProfitPrice,
      slPrice: risk.stopPrice,
      status: 'OPEN' as TradeStatus,
      closedTs: null,
      closedPrice: null,
      pnlQuote: null,
      pnlPct: null,
      mode: 'live',
      strategyName: config.trading.strategyName,
    };
```

- [ ] **Step 7: Wire `strategyName` into call site — `orchestrator.ts`**

Edit `src/strategy/orchestrator.ts`. Locate the `insertDecision({...})` call (around line 103-120). Add `strategyName: config.trading.strategyName,` as the last property:
```typescript
    const decisionId = insertDecision({
      ts: Date.now(),
      symbol,
      action: llmResult.decision.action,
      confidence: llmResult.decision.confidence,
      reason: llmResult.decision.reason,
      stopLossPct: llmResult.decision.stopLossPercent,
      takeProfitPct: llmResult.decision.takeProfitPercent,
      timeHorizonMinutes: llmResult.decision.timeHorizonMinutes,
      priceAtDecision: snapshot.currentPrice,
      llmModel: llmResult.model,
      llmInputTokens: llmResult.usage.inputTokens,
      llmOutputTokens: llmResult.usage.outputTokens,
      llmCostUsd: llmResult.usage.costUsd,
      executed: false,
      skipReason: null,
      mode: this.mode,
      strategyName: config.trading.strategyName,
    });
```

- [ ] **Step 8: Type-check the whole project**

Run: `cd /home/luan/test-claude/trade && npx tsc --noEmit`
Expected: no TypeScript errors.

- [ ] **Step 9: Re-run the test**

Run: `npm test -- src/storage/strategy-name.spec.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/storage/trades.ts src/storage/decisions.ts src/executor/trade-executor.ts src/strategy/orchestrator.ts src/storage/strategy-name.spec.ts
git commit -m "feat(storage): persist strategyName on trades and decisions"
```

---

## Task 5: `paper/daily-gate.ts` with tests (TDD)

**Files:**
- Create: `src/paper/daily-gate.ts`
- Create: `src/paper/daily-gate.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `src/paper/daily-gate.spec.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./data/test-daily-gate.db');
process.env.DB_PATH = TEST_DB;
process.env.ACCOUNT_EQUITY_USD = '1000';
process.env.MAX_DAILY_LOSS_PCT = '3.0';
process.env.MAX_DAILY_LOSSES = '3';

import { getDb, closeDb } from '../storage/db';
import { insertTrade, TradeRecord } from '../storage/trades';
import { checkDailyGate } from './daily-gate';

function resetDb() {
  closeDb();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  getDb();
}

function makeClosedTrade(opts: { closedTs: number; pnlQuote: number; pnlPct: number }): TradeRecord {
  return {
    decisionId: null,
    ts: opts.closedTs - 3_600_000,
    symbol: 'BTCUSDT',
    side: 'BUY',
    qty: 0.001,
    avgPrice: 60000,
    quoteQty: 60,
    binanceOrderId: `SIM-${opts.closedTs}`,
    ocoOrderListId: null,
    tpPrice: 61200,
    slPrice: 59400,
    status: opts.pnlQuote > 0 ? 'TP_FILLED' : 'SL_FILLED',
    closedTs: opts.closedTs,
    closedPrice: 60000 + opts.pnlQuote / 0.001,
    pnlQuote: opts.pnlQuote,
    pnlPct: opts.pnlPct,
    mode: 'dryrun',
    strategyName: 'test',
  };
}

function todayUtcMidnight(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

describe('checkDailyGate', () => {
  beforeEach(() => resetDb());

  it('allows when no trades today', () => {
    expect(checkDailyGate().allowed).toBe(true);
  });

  it('allows after 1 small loss', () => {
    insertTrade(makeClosedTrade({ closedTs: todayUtcMidnight() + 3_600_000, pnlQuote: -10, pnlPct: -1.0 }));
    expect(checkDailyGate().allowed).toBe(true);
  });

  it('blocks when daily DD >= MAX_DAILY_LOSS_PCT', () => {
    const start = todayUtcMidnight() + 3_600_000;
    insertTrade(makeClosedTrade({ closedTs: start, pnlQuote: -20, pnlPct: -2.0 }));
    insertTrade(makeClosedTrade({ closedTs: start + 1000, pnlQuote: -15, pnlPct: -1.5 }));
    const result = checkDailyGate();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('DD');
  });

  it('blocks on consecutive-loss streak >= MAX_DAILY_LOSSES', () => {
    const start = todayUtcMidnight() + 3_600_000;
    insertTrade(makeClosedTrade({ closedTs: start, pnlQuote: -5, pnlPct: -0.5 }));
    insertTrade(makeClosedTrade({ closedTs: start + 1000, pnlQuote: -5, pnlPct: -0.5 }));
    insertTrade(makeClosedTrade({ closedTs: start + 2000, pnlQuote: -5, pnlPct: -0.5 }));
    const result = checkDailyGate();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('streak');
  });

  it('streak resets after a win', () => {
    const start = todayUtcMidnight() + 3_600_000;
    insertTrade(makeClosedTrade({ closedTs: start, pnlQuote: -5, pnlPct: -0.5 }));
    insertTrade(makeClosedTrade({ closedTs: start + 1000, pnlQuote: -5, pnlPct: -0.5 }));
    insertTrade(makeClosedTrade({ closedTs: start + 2000, pnlQuote: +5, pnlPct: +0.5 }));
    insertTrade(makeClosedTrade({ closedTs: start + 3000, pnlQuote: -5, pnlPct: -0.5 }));
    const result = checkDailyGate();
    expect(result.allowed).toBe(true);
  });

  it('ignores trades from prior UTC day', () => {
    const yesterday = todayUtcMidnight() - 12 * 3_600_000;
    insertTrade(makeClosedTrade({ closedTs: yesterday, pnlQuote: -100, pnlPct: -10 }));
    expect(checkDailyGate().allowed).toBe(true);
  });

  it('ignores live trades when in dryrun mode', () => {
    const start = todayUtcMidnight() + 3_600_000;
    const liveLoser = { ...makeClosedTrade({ closedTs: start, pnlQuote: -50, pnlPct: -5 }), mode: 'live' as const };
    insertTrade(liveLoser);
    expect(checkDailyGate().allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- src/paper/daily-gate.spec.ts`
Expected: FAIL — module `./daily-gate` not found.

- [ ] **Step 3: Implement `daily-gate.ts`**

Create `src/paper/daily-gate.ts`:
```typescript
import { getDb } from '../storage/db';
import { config } from '../config/config';

export interface GateResult {
  allowed: boolean;
  reason?: string;
  ddPct: number;
  streak: number;
}

function utcMidnightToday(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function checkDailyGate(): GateResult {
  const start = utcMidnightToday();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT pnl_quote, closed_ts
       FROM trades
       WHERE closed_ts IS NOT NULL
         AND closed_ts >= ?
         AND mode = 'dryrun'
         AND status IN ('TP_FILLED','SL_FILLED','CANCELED')
       ORDER BY closed_ts ASC`,
    )
    .all(start) as { pnl_quote: number; closed_ts: number }[];

  const negSum = rows.filter((r) => r.pnl_quote < 0).reduce((s, r) => s + r.pnl_quote, 0);
  const ddPct = (Math.abs(negSum) / config.trading.accountEquityUsd) * 100;

  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].pnl_quote < 0) streak += 1;
    else break;
  }

  if (ddPct >= config.trading.maxDailyLossPct) {
    return {
      allowed: false,
      reason: `Daily DD ${ddPct.toFixed(2)}% >= cap ${config.trading.maxDailyLossPct}%`,
      ddPct,
      streak,
    };
  }
  if (streak >= config.trading.maxDailyLosses) {
    return {
      allowed: false,
      reason: `Loss streak ${streak} >= cap ${config.trading.maxDailyLosses}`,
      ddPct,
      streak,
    };
  }
  return { allowed: true, ddPct, streak };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/paper/daily-gate.spec.ts`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add src/paper/daily-gate.ts src/paper/daily-gate.spec.ts
git commit -m "feat(paper): daily-loss gate (DD% or consecutive streak)"
```

---

## Task 6: `paper/fill-simulator.ts` with tests (TDD)

**Files:**
- Create: `src/paper/fill-simulator.ts`
- Create: `src/paper/fill-simulator.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `src/paper/fill-simulator.spec.ts`:
```typescript
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
    const result = simulateFill(baseTrade, klines, 1000);
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
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- src/paper/fill-simulator.spec.ts`
Expected: FAIL — module `./fill-simulator` not found.

- [ ] **Step 3: Implement `fill-simulator.ts`**

Create `src/paper/fill-simulator.ts`:
```typescript
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
```

- [ ] **Step 4: Run pure-function tests to verify they pass**

Run: `npm test -- src/paper/fill-simulator.spec.ts`
Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add src/paper/fill-simulator.ts src/paper/fill-simulator.spec.ts
git commit -m "feat(paper): fill-simulator with 15m candles + pessimistic same-candle rule"
```

---

## Task 7: Refactor `closer.ts` — expose `persistClose`, remove dryrun-timeout path

**Files:**
- Modify: `src/postmortem/closer.ts`
- Modify: `src/strategy/orchestrator.ts`

- [ ] **Step 1: Make `persistClose` public + accept optional `notes`**

Edit `src/postmortem/closer.ts`. Find the private `persistClose` method (around line 94). Change it to public and add a `notes` parameter:
```typescript
  async persistClose(
    trade: TradeRecord,
    exitPrice: number,
    closedTs: number,
    outcome: PostmortemOutcome,
    notes: string | null = null,
  ): Promise<void> {
    if (!trade.id) return;

    const isLong = trade.side === 'BUY';
    const pnlQuote = isLong
      ? (exitPrice - trade.avgPrice) * trade.qty
      : (trade.avgPrice - exitPrice) * trade.qty;
    const pnlPct = isLong
      ? ((exitPrice - trade.avgPrice) / trade.avgPrice) * 100
      : ((trade.avgPrice - exitPrice) / trade.avgPrice) * 100;
    const holdingMinutes = (closedTs - trade.ts) / 60_000;

    const tradeStatus: TradeStatus =
      outcome === 'TP_HIT' ? 'TP_FILLED' : outcome === 'SL_HIT' ? 'SL_FILLED' : 'CANCELED';
    closeTrade(trade.id, tradeStatus, exitPrice, pnlQuote, pnlPct);

    const maeMfe = await this.computeMaeMfe(trade, closedTs);

    const classification: PostmortemClassification = this.classify(outcome, pnlQuote);

    insertPostmortem({
      tradeId: trade.id,
      closedTs,
      outcome,
      pnlQuote,
      pnlPct,
      holdingMinutes,
      maePct: maeMfe?.maePct ?? null,
      mfePct: maeMfe?.mfePct ?? null,
      classification,
      notes,
    });

    log.info('Trade closed + postmortem recorded', {
      tradeId: trade.id,
      symbol: trade.symbol,
      outcome,
      pnlPct: pnlPct.toFixed(2),
      classification,
      notes,
    });
  }
```

- [ ] **Step 2: Remove `runDryrunTimeout` and `tryCloseDryrunTimeout`**

In the same file, delete the entire `runDryrunTimeout` method (around line 26-31) and the entire private `tryCloseDryrunTimeout` method (around line 75-82). Also delete the conditional `isLive ? await this.tryCloseLive(trade) : await this.tryCloseDryrunTimeout(trade)` — `processBatch` is now only used by `runLive`; simplify it:

Replace the existing `processBatch` (currently calls both live and dryrun paths) with a live-only version:
```typescript
  private async processBatch(trades: TradeRecord[]): Promise<CloserResult> {
    const result: CloserResult = { checked: trades.length, closed: 0, errors: 0 };

    for (const trade of trades) {
      if (!trade.id) continue;
      if (postmortemExistsForTrade(trade.id)) continue;

      try {
        const closed = await this.tryCloseLive(trade);
        if (closed) result.closed += 1;
      } catch (err: any) {
        log.error('Closer error', { tradeId: trade.id, symbol: trade.symbol, err: err.message });
        result.errors += 1;
      }
    }

    return result;
  }
```

And update `runLive` to call the simplified processor:
```typescript
  async runLive(): Promise<CloserResult> {
    const open = getOpenTrades().filter((t) => t.mode === 'live');
    return this.processBatch(open);
  }
```

- [ ] **Step 3: Update orchestrator to use `FillSimulator` for dryrun**

Edit `src/strategy/orchestrator.ts`. Add import near other imports:
```typescript
import { FillSimulator } from '../paper/fill-simulator';
```

Add a `fillSim` private field and initialize it in the constructor:
```typescript
export class Orchestrator {
  private pub: BinancePublicClient;
  private priv: BinancePrivateClient | null;
  private claude: ClaudeClient;
  private executor: TradeExecutor;
  private closer: TradeCloser;
  private fillSim: FillSimulator;
  private mode: ExecutionMode;

  constructor(mode: ExecutionMode) {
    this.pub = new BinancePublicClient();
    this.priv =
      mode === 'live'
        ? new BinancePrivateClient(config.binance.apiKey, config.binance.apiSecret)
        : null;
    this.claude = new ClaudeClient();
    this.executor = new TradeExecutor(this.priv);
    this.closer = new TradeCloser(this.pub, this.priv);
    this.fillSim = new FillSimulator(this.pub, this.closer);
    this.mode = mode;
  }
```

Replace the body of `closeMatured` to dispatch by mode:
```typescript
  async closeMatured(): Promise<CloserResult> {
    if (this.mode === 'live') {
      return this.closer.runLive();
    }
    return this.fillSim.runDryrunFillSim();
  }
```

- [ ] **Step 4: Type-check**

Run: `cd /home/luan/test-claude/trade && npx tsc --noEmit`
Expected: no TypeScript errors.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: all tests pass (strategy-name + daily-gate + fill-simulator).

- [ ] **Step 6: Commit**

```bash
git add src/postmortem/closer.ts src/strategy/orchestrator.ts
git commit -m "refactor(closer): expose persistClose, dryrun routes via FillSimulator"
```

---

## Task 8: Wire daily gate into orchestrator (top of `runSymbol`)

**Files:**
- Modify: `src/strategy/orchestrator.ts`

- [ ] **Step 1: Update `SymbolResult` outcome union**

Edit `src/strategy/orchestrator.ts`. Replace the `outcome` union in `SymbolResult` to include `SKIPPED_DAILY_GATE`:
```typescript
export interface SymbolResult {
  symbol: string;
  outcome:
    | 'SKIPPED_COOLDOWN'
    | 'SKIPPED_EMA'
    | 'SKIPPED_DECISION'
    | 'SKIPPED_DAILY_GATE'
    | 'EXECUTED'
    | 'ERROR';
  decisionId?: number;
  executionResult?: ExecutionResult;
  reason?: string;
  costUsd?: number;
}
```

- [ ] **Step 2: Call daily gate at the very top of `runSymbol`**

Add import near other imports:
```typescript
import { checkDailyGate } from '../paper/daily-gate';
```

Then at the start of `runSymbol` (before the cooldown check), insert the gate check — only for dryrun mode:
```typescript
  async runSymbol(symbol: string): Promise<SymbolResult> {
    if (this.mode === 'dryrun') {
      const gate = checkDailyGate();
      if (!gate.allowed) {
        return {
          symbol,
          outcome: 'SKIPPED_DAILY_GATE',
          reason: gate.reason,
        };
      }
    }

    if (isInCooldown(symbol, config.trading.cooldownMinutes)) {
      const remaining = remainingCooldownMinutes(symbol, config.trading.cooldownMinutes);
      return {
        symbol,
        outcome: 'SKIPPED_COOLDOWN',
        reason: `cooldown active, ${remaining.toFixed(1)} min remaining`,
      };
    }
    // ... rest unchanged
```

- [ ] **Step 3: Make sure `loop.ts` logs the new outcome**

Edit `src/loop.ts`. The current `logResults` treats anything not `EXECUTED`/`ERROR` as skipped — `SKIPPED_DAILY_GATE` will naturally fall into the `else` branch. No code change needed here, but verify by reading the existing logic (around line 87-127) and confirming the `else` handles it.

- [ ] **Step 4: Type-check**

Run: `cd /home/luan/test-claude/trade && npx tsc --noEmit`
Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/strategy/orchestrator.ts
git commit -m "feat(orchestrator): daily-loss gate skips dryrun decisions when capped"
```

---

## Task 9: Stats CLI script + HTML dashboard

**Files:**
- Create: `src/scripts/stats.ts`
- Modify: `package.json` (add `stats` script)
- Modify: `.gitignore` (ignore `data/stats.html`)

- [ ] **Step 1: Create `src/scripts/stats.ts` with CLI output**

Create `src/scripts/stats.ts`:
```typescript
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
  const equityCurve: { ts: number; equity: number }[] = [{ ts: closed[0]?.ts ?? Date.now(), equity: startingEquity }];
  let runningEquity = startingEquity;
  for (const t of closed) {
    runningEquity += t.pnl_quote;
    if (runningEquity > peak) peak = runningEquity;
    const dd = ((peak - runningEquity) / peak) * 100;
    if (dd > maxDdPct) maxDdPct = dd;
    equityCurve.push({ ts: t.closed_ts, equity: runningEquity });
  }

  const bestTrade = closed.reduce<ClosedTrade | null>((b, t) => (b === null || t.pnl_quote > b.pnl_quote ? t : b), null);
  const worstTrade = closed.reduce<ClosedTrade | null>((w, t) => (w === null || t.pnl_quote < w.pnl_quote ? t : w), null);
  const avgHoldingMinutes =
    closed.length > 0 ? closed.reduce((s, t) => s + (t.closed_ts - t.ts) / 60_000, 0) / closed.length : 0;
  const avgRrRatio =
    closed.length > 0
      ? closed.reduce((s, t) => (t.tp_pct && t.sl_pct ? s + t.tp_pct / t.sl_pct : s), 0) / closed.length
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
  console.log(`  Trades:        ${stats.closed.length + stats.open.length} (open: ${stats.open.length}, closed: ${stats.closed.length})`);
  console.log(
    `  Win rate:      ${(stats.winRateTotal * 100).toFixed(1)}%  (buy: ${(stats.winRateBuy * 100).toFixed(1)}% [${stats.winsBuy}/${stats.totalBuy}]  sell: ${(stats.winRateSell * 100).toFixed(1)}% [${stats.winsSell}/${stats.totalSell}])`,
  );
  console.log(`  Realized PnL:  ${formatUsd(stats.realizedPnlQuote)}  (${formatPct(stats.realizedPnlPct)})`);
  console.log(`  Open PnL:      ${formatUsd(stats.openPnlQuote)}`);
  console.log(`  Equity:        $${stats.equityNow.toFixed(2)}  (start $${stats.startingEquity.toFixed(2)})`);
  console.log(`  Max DD:        -${stats.maxDdPct.toFixed(2)}%`);
  if (stats.bestTrade) console.log(`  Best trade:    ${formatUsd(stats.bestTrade.pnl_quote)}  (${stats.bestTrade.symbol} ${stats.bestTrade.side})`);
  if (stats.worstTrade) console.log(`  Worst trade:   ${formatUsd(stats.worstTrade.pnl_quote)}  (${stats.worstTrade.symbol} ${stats.worstTrade.side})`);
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
```

- [ ] **Step 2: Add npm script**

Edit `package.json`. In the `scripts` block, add right before `"dryrun"`:
```json
"stats": "ts-node src/scripts/stats.ts",
```

- [ ] **Step 3: Update `.gitignore`**

Edit `.gitignore`. Add at the end (on its own line):
```
data/stats.html
```

- [ ] **Step 4: Smoke test — runs even with empty DB**

Run:
```bash
cd /home/luan/test-claude/trade
rm -f data/trade.db data/stats.html
npm run stats
```
Expected:
- Prints "PAPER STATS — ema9_21+claude_v1" header.
- Most numbers are 0 (empty DB).
- Daily gate reports "OK".
- A file `data/stats.html` exists. Open with `xdg-open data/stats.html` (or just check `ls -la data/stats.html`).

- [ ] **Step 5: Smoke test — insert a fake trade and re-run**

Insert one synthetic closed trade:
```bash
npx ts-node -e "
import { getDb, closeDb } from './src/storage/db';
import { insertTrade } from './src/storage/trades';
const now = Date.now();
const tradeId = insertTrade({
  decisionId: null,
  ts: now - 3_600_000,
  symbol: 'BTCUSDT',
  side: 'BUY',
  qty: 0.001,
  avgPrice: 60000,
  quoteQty: 60,
  binanceOrderId: 'SIM-test',
  ocoOrderListId: null,
  tpPrice: 61200,
  slPrice: 59400,
  status: 'TP_FILLED',
  closedTs: now,
  closedPrice: 61200,
  pnlQuote: 1.2,
  pnlPct: 2.0,
  mode: 'dryrun',
  strategyName: 'ema9_21+claude_v1',
});
console.log('inserted', tradeId);
closeDb();
"
npm run stats
```

Expected: CLI reports `Trades: 1 (open: 0, closed: 1)`, `Win rate: 100.0%`, `Realized PnL: +$1.20  (+0.12%)`. HTML regenerated, contains the row in the table.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/stats.ts package.json .gitignore
git commit -m "feat(stats): CLI + HTML dashboard with editorial typography (frontend-design)"
```

---

## Task 10: End-to-end smoke verification

**Files:**
- No code changes — just verification.

- [ ] **Step 1: Confirm full test suite is green**

Run: `cd /home/luan/test-claude/trade && npm test`
Expected: all `*.spec.ts` pass. No failing tests.

- [ ] **Step 2: Confirm type-check is clean**

Run: `cd /home/luan/test-claude/trade && npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Confirm dryrun starts without crash (terminate after one cycle)**

Run (terminate with Ctrl-C after seeing one full "Cycle done" log line):
```bash
cd /home/luan/test-claude/trade
npm run dryrun
```
Expected logs you should see:
- `"Trading loop starting" ... "mode":"dryrun"`
- `"Cycle start" ... "cycle":1`
- For each symbol: either `"SKIPPED"` (EMA filter, cooldown, or daily-gate) or `"EXECUTED"` if EMA cross + Claude both agree.
- `"Cycle done"` with `elapsedMs`.

Stop with Ctrl-C. Expected: `"Shutdown signal received"` then `"Trading loop stopped"`.

- [ ] **Step 4: Confirm stats reads the live DB after dryrun**

Run: `npm run stats`
Expected: prints stats (may be all zeros if no trade executed in step 3), writes `data/stats.html`. Open it in a browser if you can; verify fonts load (Fraunces + JetBrains Mono), Chart.js renders the curve baseline at $1000 (empty curve still draws one point).

- [ ] **Step 5: Final commit (no-op — nothing to commit, but record the verification)**

If everything passes, this task is complete. If anything fails, treat as a real bug — file in your head, fix, retest.

---

## Self-review notes

- **Spec coverage:** all sections covered (Migration → Task 3; Fill Simulator → Task 6; Daily Gate → Task 5; Strategy tag → Tasks 3+4; Stats CLI+HTML → Task 9; orchestrator wiring → Tasks 7+8; loop wiring → orchestrator.closeMatured swap in Task 7).
- **Placeholder scan:** every step has exact paths, exact code, exact commands.
- **Type consistency:** `strategyName` used everywhere (camelCase TS), `strategy_name` everywhere (snake_case SQL). `FillCandidate.maxHoldHours` matches `dryrunMaxHoldHours` config field intent. `persistClose(trade, exitPrice, closedTs, outcome, notes)` signature consistent between Task 7 and the call sites in fill-simulator Task 6.
- **Out of scope (per spec):** no composable signals framework, no multi-timeframe, no live-mode changes beyond `strategyName` field propagation.
