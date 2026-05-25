# Dashboard Settings Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser settings screen to the paper-trading dashboard to edit the LLM, period(s), risk/sizing, entry filters, symbols, and daily limits, persisting to `data/settings.json` and auto-restarting the loop to apply.

**Architecture:** A new `settings-store` module owns a zod-validated whitelist of editable fields persisted to `data/settings.json`. `config.ts` overlays those settings onto `process.env` at load time, so the spawned loop child (a fresh process) picks them up at boot. A new `effective-settings` resolver merges live settings over the boot-time config for display freshness. The dashboard server exposes `GET/POST /api/settings`; saving triggers `LoopController.restart()` when the loop is running.

**Tech Stack:** TypeScript, Node `http`, zod, better-sqlite3 (unchanged), vitest, vanilla JS SPA.

---

## File Structure

- **Create** `src/config/settings-store.ts` — whitelist schema, read/write `data/settings.json`, env mapping. No config import (avoids cycle).
- **Create** `src/config/effective-settings.ts` — merges live settings over boot config; lists keyed providers. Imports config + settings-store.
- **Modify** `src/config/config.ts` — overlay settings into `process.env` in `loadConfig()`; add `trading.klineInterval`; export `loadConfig`.
- **Modify** `src/strategy/market-data.ts` — source `DEFAULT_FETCH.klineInterval` from config.
- **Modify** `src/dashboard/loop-controller.ts` — add `restart()`.
- **Modify** `src/dashboard/server.ts` — `GET/POST /api/settings` + JSON body reader.
- **Modify** `src/dashboard/stats-reader.ts` — snapshot `llm` from `effective-settings`.
- **Modify** `src/dashboard/index.html`, `src/dashboard/styles.css`, `src/dashboard/app.js` — settings slide-over panel.
- **Create** tests: `src/config/settings-store.spec.ts`, `src/config/effective-settings.spec.ts`; extend `src/dashboard/server.spec.ts`, `src/dashboard/loop-controller.spec.ts`, `src/config/config.spec.ts` (create if absent).

---

## Task 1: settings-store module

**Files:**
- Create: `src/config/settings-store.ts`
- Test: `src/config/settings-store.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/config/settings-store.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readSettings,
  writeSettings,
  settingsToEnv,
  SettingsValidationError,
} from './settings-store';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-store-'));
  process.env.SETTINGS_PATH = path.join(dir, 'settings.json');
});
afterEach(() => {
  delete process.env.SETTINGS_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('settings-store', () => {
  it('returns {} when the file is absent', () => {
    expect(readSettings()).toEqual({});
  });

  it('round-trips a valid write', () => {
    const saved = writeSettings({ llmProvider: 'deepseek', llmModel: 'deepseek-chat', klineInterval: '4h' });
    expect(saved.klineInterval).toBe('4h');
    expect(readSettings().llmProvider).toBe('deepseek');
  });

  it('merges partial writes over existing', () => {
    writeSettings({ klineInterval: '1h', loopIntervalMinutes: 15 });
    writeSettings({ loopIntervalMinutes: 30 });
    const s = readSettings();
    expect(s.klineInterval).toBe('1h');
    expect(s.loopIntervalMinutes).toBe(30);
  });

  it('strips unknown and secret keys', () => {
    const saved = writeSettings({ klineInterval: '1h', ANTHROPIC_API_KEY: 'x', mode: 'live' } as any);
    expect((saved as any).ANTHROPIC_API_KEY).toBeUndefined();
    expect((saved as any).mode).toBeUndefined();
  });

  it('throws SettingsValidationError on invalid values', () => {
    expect(() => writeSettings({ amountUsd: 999 })).toThrow(SettingsValidationError);
    expect(() => writeSettings({ klineInterval: '7m' as any })).toThrow(SettingsValidationError);
  });

  it('maps settings to provider-specific env vars', () => {
    const env = settingsToEnv({ llmProvider: 'anthropic', llmModel: 'claude-opus-4-7', loopIntervalMinutes: 30, symbols: 'BTCUSDT' });
    expect(env.LLM_PROVIDER).toBe('anthropic');
    expect(env.CLAUDE_MODEL).toBe('claude-opus-4-7');
    expect(env.LOOP_INTERVAL_MINUTES).toBe('30');
    expect(env.SYMBOLS).toBe('BTCUSDT');
    expect(env.DEEPSEEK_MODEL).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/settings-store.spec.ts`
Expected: FAIL — cannot find module `./settings-store`.

- [ ] **Step 3: Write the implementation**

```ts
// src/config/settings-store.ts
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

// Mirror of ConfigSchema.trading bounds. Hardcoded (not imported from config)
// to keep this module dependency-free and avoid an import cycle: config.ts
// imports this module for the env overlay.
const MAX_TRADE_AMOUNT_USD = 200;

export const LLM_PROVIDERS = ['anthropic', 'openai', 'gemini', 'deepseek'] as const;
export const KLINE_INTERVALS = ['15m', '30m', '1h', '4h', '12h'] as const;

export const SETTINGS_SCHEMA = z
  .object({
    llmProvider: z.enum(LLM_PROVIDERS),
    llmModel: z.string().min(1),
    klineInterval: z.enum(KLINE_INTERVALS),
    loopIntervalMinutes: z.coerce.number().min(1),
    sizingMode: z.enum(['fixed', 'risk', 'atr']),
    amountUsd: z.coerce.number().positive().max(MAX_TRADE_AMOUNT_USD),
    riskPctPerTrade: z.coerce.number().min(0.1).max(5),
    atrMultiplier: z.coerce.number().min(0.5).max(10),
    accountEquityUsd: z.coerce.number().positive(),
    minConfidence: z.coerce.number().min(0).max(100),
    minRrRatio: z.coerce.number().min(1),
    cooldownMinutes: z.coerce.number().min(0),
    symbols: z.string().min(1),
    maxDailyLossPct: z.coerce.number().min(0).max(100),
    maxDailyLosses: z.coerce.number().int().min(1),
    maxPortfolioHeatPct: z.coerce.number().min(0).max(50),
  })
  .partial();

export type Settings = z.infer<typeof SETTINGS_SCHEMA>;

export class SettingsValidationError extends Error {
  fieldErrors: Record<string, string>;
  constructor(issues: z.ZodIssue[]) {
    super('settings validation failed');
    this.name = 'SettingsValidationError';
    this.fieldErrors = {};
    for (const i of issues) this.fieldErrors[i.path.join('.')] = i.message;
  }
}

function settingsPath(): string {
  return process.env.SETTINGS_PATH || path.resolve('./data/settings.json');
}

export function readSettings(): Settings {
  const p = settingsPath();
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = SETTINGS_SCHEMA.safeParse(JSON.parse(fs.readFileSync(p, 'utf8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeSettings(partial: unknown): Settings {
  // zod strips unrecognized keys by default, so secrets/unknown fields drop out.
  const parsed = SETTINGS_SCHEMA.safeParse(partial);
  if (!parsed.success) throw new SettingsValidationError(parsed.error.issues);
  const merged = { ...readSettings(), ...parsed.data };
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(merged, null, 2));
  return merged;
}

const MODEL_ENV: Record<(typeof LLM_PROVIDERS)[number], string> = {
  anthropic: 'CLAUDE_MODEL',
  openai: 'OPENAI_MODEL',
  gemini: 'GEMINI_MODEL',
  deepseek: 'DEEPSEEK_MODEL',
};

export function settingsToEnv(s: Settings): Record<string, string> {
  const env: Record<string, string> = {};
  if (s.llmProvider) env.LLM_PROVIDER = s.llmProvider;
  if (s.llmModel && s.llmProvider) env[MODEL_ENV[s.llmProvider]] = s.llmModel;
  if (s.klineInterval) env.KLINE_INTERVAL = s.klineInterval;
  if (s.loopIntervalMinutes != null) env.LOOP_INTERVAL_MINUTES = String(s.loopIntervalMinutes);
  if (s.sizingMode) env.SIZING_MODE = s.sizingMode;
  if (s.amountUsd != null) env.TRADE_AMOUNT_USD = String(s.amountUsd);
  if (s.riskPctPerTrade != null) env.RISK_PCT_PER_TRADE = String(s.riskPctPerTrade);
  if (s.atrMultiplier != null) env.ATR_MULTIPLIER = String(s.atrMultiplier);
  if (s.accountEquityUsd != null) env.ACCOUNT_EQUITY_USD = String(s.accountEquityUsd);
  if (s.minConfidence != null) env.MIN_CONFIDENCE = String(s.minConfidence);
  if (s.minRrRatio != null) env.MIN_RR_RATIO = String(s.minRrRatio);
  if (s.cooldownMinutes != null) env.COOLDOWN_MINUTES = String(s.cooldownMinutes);
  if (s.symbols) env.SYMBOLS = s.symbols;
  if (s.maxDailyLossPct != null) env.MAX_DAILY_LOSS_PCT = String(s.maxDailyLossPct);
  if (s.maxDailyLosses != null) env.MAX_DAILY_LOSSES = String(s.maxDailyLosses);
  if (s.maxPortfolioHeatPct != null) env.MAX_PORTFOLIO_HEAT_PCT = String(s.maxPortfolioHeatPct);
  return env;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/settings-store.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/settings-store.ts src/config/settings-store.spec.ts
git commit -m "feat(config): settings-store — whitelist schema, persist, env mapping"
```

---

## Task 2: config.ts overlay + klineInterval

**Files:**
- Modify: `src/config/config.ts:46-66` (trading schema), `src/config/config.ts:98-143` (loadConfig), `src/config/config.ts:183-184` (exports)
- Test: `src/config/config.spec.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// src/config/config.spec.ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from './config';

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

describe('loadConfig settings overlay', () => {
  it('defaults klineInterval to 1h when nothing is set', () => {
    delete process.env.KLINE_INTERVAL;
    // point at a guaranteed-absent file so a real ./data/settings.json can't leak in
    process.env.SETTINGS_PATH = path.join(os.tmpdir(), `cfg-absent-${Date.now()}.json`);
    expect(loadConfig().trading.klineInterval).toBe('1h');
  });

  it('lets settings.json override env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-overlay-'));
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ klineInterval: '4h', loopIntervalMinutes: 30 }),
    );
    process.env.SETTINGS_PATH = path.join(dir, 'settings.json');
    process.env.KLINE_INTERVAL = '1h'; // settings must win
    const cfg = loadConfig();
    expect(cfg.trading.klineInterval).toBe('4h');
    expect(cfg.trading.loopIntervalMinutes).toBe(30);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/config.spec.ts`
Expected: FAIL — `loadConfig` is not exported / `klineInterval` undefined.

- [ ] **Step 3: Add `klineInterval` to the trading schema**

In `src/config/config.ts`, inside the `trading: z.object({ ... })` block, add after the `loopIntervalMinutes` line:

```ts
    klineInterval: z.enum(['15m', '30m', '1h', '4h', '12h']).default('1h'),
```

- [ ] **Step 4: Add the overlay + raw field + export**

At the top of `src/config/config.ts`, add the import after the existing imports:

```ts
import { readSettings, settingsToEnv } from './settings-store';
```

At the start of `loadConfig()` (before `const raw = {`), add:

```ts
  // settings.json overrides .env: overlay it onto process.env before reading.
  const overlay = settingsToEnv(readSettings());
  for (const [k, v] of Object.entries(overlay)) process.env[k] = v;
```

In `raw.trading`, add after the `loopIntervalMinutes` line:

```ts
      klineInterval: process.env.KLINE_INTERVAL,
```

Change the export line near the bottom from:

```ts
export const config = loadConfig();
```

to:

```ts
export const config = loadConfig();
export { loadConfig };
```

- [ ] **Step 5: Run test + full suite to verify**

Run: `npx vitest run src/config/config.spec.ts && npx tsc --noEmit`
Expected: PASS (2 tests); tsc no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config/config.ts src/config/config.spec.ts
git commit -m "feat(config): overlay settings.json over env + klineInterval field"
```

---

## Task 3: market-data uses configured klineInterval

**Files:**
- Modify: `src/strategy/market-data.ts:1-20`
- Test: `src/strategy/market-data.spec.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// src/strategy/market-data.spec.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_FETCH } from './market-data';
import { config } from '../config/config';

describe('market-data DEFAULT_FETCH', () => {
  it('sources klineInterval from config (not a hardcoded literal)', () => {
    expect(DEFAULT_FETCH.klineInterval).toBe(config.trading.klineInterval);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/strategy/market-data.spec.ts`
Expected: may PASS only if config default already `1h` AND literal `1h` — to make the test meaningful, it fails after we set `KLINE_INTERVAL` differently. Run with override to prove wiring:
`KLINE_INTERVAL=4h npx vitest run src/strategy/market-data.spec.ts`
Expected: FAIL — `DEFAULT_FETCH.klineInterval` is `'1h'` but config is `'4h'`.

- [ ] **Step 3: Wire DEFAULT_FETCH to config**

In `src/strategy/market-data.ts`, add the import after the existing imports:

```ts
import { config } from '../config/config';
```

Change the `DEFAULT_FETCH` literal:

```ts
export const DEFAULT_FETCH: FetchOptions = {
  klineInterval: config.trading.klineInterval,
  klineLimit: 100,
  bookDepth: 10,
  emaFast: 9,
  emaSlow: 21,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `KLINE_INTERVAL=4h npx vitest run src/strategy/market-data.spec.ts`
Expected: PASS. Also `npx vitest run src/strategy/market-data.spec.ts` PASS.

- [ ] **Step 5: Commit**

```bash
git add src/strategy/market-data.ts src/strategy/market-data.spec.ts
git commit -m "feat(strategy): use configured klineInterval for snapshots"
```

---

## Task 4: effective-settings resolver

**Files:**
- Create: `src/config/effective-settings.ts`
- Test: `src/config/effective-settings.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/config/effective-settings.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { effectiveSettings, keyedProviders } from './effective-settings';
import { config } from './config';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-settings-'));
  process.env.SETTINGS_PATH = path.join(dir, 'settings.json');
});
afterEach(() => {
  delete process.env.SETTINGS_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('effective-settings', () => {
  it('falls back to config when no settings file', () => {
    const eff = effectiveSettings();
    expect(eff.klineInterval).toBe(config.trading.klineInterval);
    expect(eff.symbols).toBe(config.trading.symbols.join(','));
  });

  it('reflects live settings.json without restart', () => {
    fs.writeFileSync(process.env.SETTINGS_PATH!, JSON.stringify({ klineInterval: '12h', minConfidence: 80 }));
    const eff = effectiveSettings();
    expect(eff.klineInterval).toBe('12h');
    expect(eff.minConfidence).toBe(80);
  });

  it('lists only providers with an API key present', () => {
    const providers = keyedProviders();
    for (const p of providers) {
      expect(['anthropic', 'openai', 'gemini', 'deepseek']).toContain(p);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/effective-settings.spec.ts`
Expected: FAIL — cannot find module `./effective-settings`.

- [ ] **Step 3: Write the implementation**

```ts
// src/config/effective-settings.ts
import { config } from './config';
import { readSettings, LLM_PROVIDERS } from './settings-store';

export interface EffectiveSettings {
  llmProvider: string;
  llmModel: string;
  klineInterval: string;
  loopIntervalMinutes: number;
  sizingMode: string;
  amountUsd: number;
  riskPctPerTrade: number;
  atrMultiplier: number;
  accountEquityUsd: number;
  minConfidence: number;
  minRrRatio: number;
  cooldownMinutes: number;
  symbols: string;
  maxDailyLossPct: number;
  maxDailyLosses: number;
  maxPortfolioHeatPct: number;
}

export function effectiveSettings(): EffectiveSettings {
  const s = readSettings();
  const provider = (s.llmProvider ?? config.llm.provider) as (typeof LLM_PROVIDERS)[number];
  const model = s.llmModel ?? config[provider].model;
  const t = config.trading;
  return {
    llmProvider: provider,
    llmModel: model,
    klineInterval: s.klineInterval ?? t.klineInterval,
    loopIntervalMinutes: s.loopIntervalMinutes ?? t.loopIntervalMinutes,
    sizingMode: s.sizingMode ?? t.sizingMode,
    amountUsd: s.amountUsd ?? t.amountUsd,
    riskPctPerTrade: s.riskPctPerTrade ?? t.riskPctPerTrade,
    atrMultiplier: s.atrMultiplier ?? t.atrMultiplier,
    accountEquityUsd: s.accountEquityUsd ?? t.accountEquityUsd,
    minConfidence: s.minConfidence ?? t.minConfidence,
    minRrRatio: s.minRrRatio ?? t.minRrRatio,
    cooldownMinutes: s.cooldownMinutes ?? t.cooldownMinutes,
    symbols: s.symbols ?? t.symbols.join(','),
    maxDailyLossPct: s.maxDailyLossPct ?? t.maxDailyLossPct,
    maxDailyLosses: s.maxDailyLosses ?? t.maxDailyLosses,
    maxPortfolioHeatPct: s.maxPortfolioHeatPct ?? t.maxPortfolioHeatPct,
  };
}

export function keyedProviders(): string[] {
  return LLM_PROVIDERS.filter((p) => config[p].apiKey !== '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/effective-settings.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/effective-settings.ts src/config/effective-settings.spec.ts
git commit -m "feat(config): effective-settings resolver + keyed provider list"
```

---

## Task 5: LoopController.restart()

**Files:**
- Modify: `src/dashboard/loop-controller.ts:98-123` (after `stop()`)
- Test: `src/dashboard/loop-controller.spec.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/dashboard/loop-controller.spec.ts` inside the existing top-level `describe` (match the file's existing imports/setup for `LoopController`, `os`, `path`):

```ts
  it('restart() stops the running child and starts a fresh one', async () => {
    const pidFile = path.join(os.tmpdir(), `lc-restart-${process.pid}.pid`);
    const c = new LoopController({ command: '/bin/sleep', args: ['30'], pidFile });
    const first = c.start();
    expect(first.ok).toBe(true);
    const r = await c.restart();
    expect(r.ok).toBe(true);
    expect(c.isRunning()).toBe(true);
    expect(r.pid).not.toBe(first.pid);
    await c.stop();
    try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch {}
  });

  it('restart() just starts when nothing is running', async () => {
    const pidFile = path.join(os.tmpdir(), `lc-restart2-${process.pid}.pid`);
    const c = new LoopController({ command: '/bin/sleep', args: ['30'], pidFile });
    const r = await c.restart();
    expect(r.ok).toBe(true);
    expect(c.isRunning()).toBe(true);
    await c.stop();
    try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch {}
  });
```

If `fs`/`os`/`path` are not already imported in that spec, add `import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';` at the top.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard/loop-controller.spec.ts`
Expected: FAIL — `c.restart is not a function`.

- [ ] **Step 3: Implement restart()**

In `src/dashboard/loop-controller.ts`, add immediately after the `stop()` method (after its closing brace near line 123):

```ts
  async restart(): Promise<{ ok: boolean; pid?: number; reason?: string }> {
    await this.stop();
    return this.start();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard/loop-controller.spec.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/loop-controller.ts src/dashboard/loop-controller.spec.ts
git commit -m "feat(dashboard): LoopController.restart()"
```

---

## Task 6: server /api/settings endpoints

**Files:**
- Modify: `src/dashboard/server.ts:1-8` (imports), `:91-120` (routes), add `readJsonBody` helper near `json()` (~line 45)
- Test: `src/dashboard/server.spec.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append inside the `describe('dashboard server', ...)` block in `src/dashboard/server.spec.ts`. The `beforeAll` already sets `process.env.DB_PATH`; add at the top of the file (line 8 area, next to the DB_PATH line) a settings path so writes are isolated:

```ts
process.env.SETTINGS_PATH = path.resolve('./data/test-server-settings.json');
```

Then the tests:

```ts
  it('GET /api/settings returns values and provider meta', async () => {
    const res = await fetch(`${base}/api/settings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.values.klineInterval).toBeDefined();
    expect(Array.isArray(body.meta.providers)).toBe(true);
    expect(body.meta.klineIntervals).toContain('4h');
  });

  it('POST /api/settings persists valid settings', async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ klineInterval: '4h', minConfidence: 80 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.restarted).toBe(false); // loop not running in this test
    const after = (await (await fetch(`${base}/api/settings`)).json()) as any;
    expect(after.values.klineInterval).toBe('4h');
    expect(after.values.minConfidence).toBe(80);
  });

  it('POST /api/settings rejects invalid values with 400', async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountUsd: 999 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.errors.amountUsd).toBeDefined();
  });
```

Add cleanup of the settings file to the existing `afterAll`:

```ts
  try { if (fs.existsSync(process.env.SETTINGS_PATH!)) fs.unlinkSync(process.env.SETTINGS_PATH!); } catch {}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard/server.spec.ts`
Expected: FAIL — `/api/settings` returns 404.

- [ ] **Step 3: Add imports and body helper**

In `src/dashboard/server.ts`, extend the imports block (after line 8):

```ts
import { effectiveSettings, keyedProviders } from '../config/effective-settings';
import { writeSettings, SettingsValidationError, KLINE_INTERVALS } from '../config/settings-store';
```

Add this helper just after the `json()` function (~line 45):

```ts
  async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
```

- [ ] **Step 4: Add the routes**

In the request handler, add after the `/api/stop` block (after line 113) and before `/api/logs`:

```ts
      if (req.method === 'GET' && pathname === '/api/settings') {
        return json(res, 200, {
          values: effectiveSettings(),
          meta: { providers: keyedProviders(), klineIntervals: KLINE_INTERVALS, maxAmountUsd: 200 },
        });
      }
      if (req.method === 'POST' && pathname === '/api/settings') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          return json(res, 400, { ok: false, reason: 'invalid JSON' });
        }
        try {
          writeSettings(body);
        } catch (e) {
          if (e instanceof SettingsValidationError) {
            return json(res, 400, { ok: false, errors: e.fieldErrors });
          }
          throw e;
        }
        let restarted = false;
        if (controller.isRunning()) {
          await controller.restart();
          restarted = true;
        }
        return json(res, 200, { ok: true, restarted });
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/dashboard/server.spec.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/server.ts src/dashboard/server.spec.ts
git commit -m "feat(dashboard): GET/POST /api/settings"
```

---

## Task 7: snapshot llm from effective-settings

**Files:**
- Modify: `src/dashboard/stats-reader.ts:1-13` (import), `:136` (llm line)

- [ ] **Step 1: Update the failing expectation**

The existing `src/dashboard/server.spec.ts` "GET /api/status returns a snapshot" test still passes; add an assertion to it:

```ts
    expect(body.llm.provider).toBeDefined();
    expect(body.llm.model).toBeDefined();
```

- [ ] **Step 2: Run test to verify current behavior**

Run: `npx vitest run src/dashboard/server.spec.ts`
Expected: PASS (the snapshot already has `llm` from the earlier feature). This task makes it source from live settings.

- [ ] **Step 3: Switch llm source to effective-settings**

In `src/dashboard/stats-reader.ts`, add to the imports:

```ts
import { effectiveSettings } from '../config/effective-settings';
```

Replace the snapshot `llm` line (currently `llm: { provider: config.llm.provider, model: config[config.llm.provider].model }`) with:

```ts
      llm: (() => {
        const eff = effectiveSettings();
        return { provider: eff.llmProvider, model: eff.llmModel };
      })(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard/server.spec.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/stats-reader.ts src/dashboard/server.spec.ts
git commit -m "feat(dashboard): snapshot LLM reads live effective settings"
```

---

## Task 8: settings panel UI

**Files:**
- Modify: `src/dashboard/index.html` (control bar button + panel markup), `src/dashboard/styles.css` (panel styles), `src/dashboard/app.js` (load/render/save)

No unit test (no DOM harness in this repo); verify manually via the running dashboard. The `/api/settings` contract is covered by Task 6.

- [ ] **Step 1: Add the gear button + panel markup**

In `src/dashboard/index.html`, inside `<span id="control-action">` (after the stop-confirm span, before `</span>` on line 26), add:

```html
      <button id="btn-settings" class="btn">⚙ settings</button>
```

Before the closing `</body>` (after the log-drawer `</div>`, ~line 78), add:

```html
<div id="settings-drawer" class="settings-drawer collapsed">
  <div class="settings-head">
    <span>Settings</span>
    <button id="settings-close" class="btn">✕</button>
  </div>
  <form id="settings-form" class="settings-form">
    <fieldset><legend>LLM</legend>
      <label>provider <select name="llmProvider" id="f-provider"></select></label>
      <label>model <input name="llmModel" type="text" /></label>
    </fieldset>
    <fieldset><legend>Período</legend>
      <label>candle timeframe <select name="klineInterval" id="f-kline"></select></label>
      <label>loop interval (min) <input name="loopIntervalMinutes" type="number" min="1" /></label>
    </fieldset>
    <fieldset><legend>Sizing & risco</legend>
      <label>sizing mode <select name="sizingMode">
        <option value="fixed">fixed</option><option value="risk">risk</option><option value="atr">atr</option>
      </select></label>
      <label>amount USD <input name="amountUsd" type="number" step="1" min="1" max="200" /></label>
      <label>risk % / trade <input name="riskPctPerTrade" type="number" step="0.1" min="0.1" max="5" /></label>
      <label>ATR multiplier <input name="atrMultiplier" type="number" step="0.1" min="0.5" max="10" /></label>
      <label>account equity USD <input name="accountEquityUsd" type="number" step="1" min="1" /></label>
    </fieldset>
    <fieldset><legend>Filtros</legend>
      <label>min confidence <input name="minConfidence" type="number" min="0" max="100" /></label>
      <label>min R/R <input name="minRrRatio" type="number" step="0.1" min="1" /></label>
      <label>cooldown (min) <input name="cooldownMinutes" type="number" min="0" /></label>
    </fieldset>
    <fieldset><legend>Símbolos</legend>
      <label>symbols (csv) <input name="symbols" type="text" /></label>
    </fieldset>
    <fieldset><legend>Limites diários</legend>
      <label>max daily loss % <input name="maxDailyLossPct" type="number" step="0.1" min="0" max="100" /></label>
      <label>max daily losses <input name="maxDailyLosses" type="number" min="1" step="1" /></label>
      <label>max portfolio heat % <input name="maxPortfolioHeatPct" type="number" step="0.1" min="0" max="50" /></label>
    </fieldset>
    <div class="settings-actions">
      <button type="submit" id="settings-save" class="btn">Save</button>
      <span id="settings-msg" class="dim"></span>
    </div>
  </form>
</div>
```

- [ ] **Step 2: Add panel styles**

Append to `src/dashboard/styles.css`:

```css
.settings-drawer { position: fixed; top: 0; right: 0; width: 380px; max-width: 92vw; height: 100vh; background: #0f0f0f; border-left: 1px solid var(--rule); overflow-y: auto; transition: transform 0.18s ease; z-index: 50; }
.settings-drawer.collapsed { transform: translateX(100%); }
.settings-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--rule); font-size: 13px; text-transform: uppercase; letter-spacing: 0.2em; color: var(--dim); }
.settings-form { padding: 16px 20px; }
.settings-form fieldset { border: 1px solid var(--rule); border-radius: 4px; margin-bottom: 14px; padding: 10px 12px; }
.settings-form legend { font-size: 11px; text-transform: uppercase; letter-spacing: 0.15em; color: var(--dim); padding: 0 6px; }
.settings-form label { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 12px; margin: 7px 0; color: var(--fg, #f5f1e8); }
.settings-form input, .settings-form select { background: #1a1a1a; border: 1px solid var(--rule); color: inherit; font-family: 'JetBrains Mono', monospace; font-size: 12px; padding: 4px 6px; width: 160px; }
.settings-form label.invalid input, .settings-form label.invalid select { border-color: #c0504d; }
.settings-actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
```

- [ ] **Step 3: Add load/render/save JS**

Append to `src/dashboard/app.js` (before or after the live-stream block; uses the existing `api`, `$` helpers):

```js
// --- settings panel ---
const settingsForm = $('settings-form');

function fillSelect(sel, options, current) {
  sel.innerHTML = options.map((o) => `<option value="${o}"${o === current ? ' selected' : ''}>${o}</option>`).join('');
}

async function loadSettings() {
  const data = await fetch(api('/api/settings')).then((r) => r.json());
  fillSelect($('f-provider'), data.meta.providers, data.values.llmProvider);
  fillSelect($('f-kline'), data.meta.klineIntervals, data.values.klineInterval);
  for (const [k, v] of Object.entries(data.values)) {
    const el = settingsForm.elements[k];
    if (el && el.tagName !== 'SELECT') el.value = v;
  }
}

$('btn-settings').addEventListener('click', () => {
  $('settings-drawer').classList.remove('collapsed');
  loadSettings().catch(() => { $('settings-msg').textContent = 'load failed'; });
});
$('settings-close').addEventListener('click', () => $('settings-drawer').classList.add('collapsed'));

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  settingsForm.querySelectorAll('label.invalid').forEach((l) => l.classList.remove('invalid'));
  const payload = {};
  for (const el of settingsForm.elements) {
    if (!el.name) continue;
    payload[el.name] = el.value;
  }
  $('settings-msg').textContent = 'saving…';
  const res = await fetch(api('/api/settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (res.ok) {
    $('settings-msg').textContent = body.restarted ? 'saved · loop restarted' : 'saved';
  } else if (body.errors) {
    for (const field of Object.keys(body.errors)) {
      const el = settingsForm.elements[field];
      if (el && el.closest('label')) el.closest('label').classList.add('invalid');
    }
    $('settings-msg').textContent = 'fix highlighted fields';
  } else {
    $('settings-msg').textContent = body.reason || 'save failed';
  }
});
```

- [ ] **Step 4: Manual verification**

Run: `npm run dashboard` (or the project's dashboard start script), open the dashboard URL.
Verify:
1. ⚙ settings opens the slide-over.
2. Provider dropdown lists only keyed providers; current values prefilled.
3. Save with a valid change → "saved" (or "saved · loop restarted" if loop running); reopen shows persisted value; `data/settings.json` exists.
4. Save `amount USD = 999` → field highlights, message "fix highlighted fields", 400 from server.
5. With loop running, save → loop child restarts (new PID in logs) and picks up the new klineInterval/interval.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/index.html src/dashboard/styles.css src/dashboard/app.js
git commit -m "feat(dashboard): settings slide-over panel"
```

---

## Final verification

- [ ] Run the full suite + typecheck:

Run: `npx vitest run && npx tsc --noEmit`
Expected: all specs PASS; tsc no errors.

- [ ] Confirm `data/settings.json` and `data/test-*.json` are gitignored:

Run: `git check-ignore data/settings.json data/test-server-settings.json`
Expected: both paths printed (ignored). If not, add `data/` coverage to `.gitignore`.
