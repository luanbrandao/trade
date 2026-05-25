# Dashboard Settings Screen — Design

**Date:** 2026-05-25
**Status:** Approved (pending spec review)

## Goal

Add a settings screen to the paper-trading dashboard so the user can choose,
from the browser, the active LLM, the risk/sizing parameters, the time
period(s), and the other tunable trading parameters — without editing `.env`
by hand or restarting processes manually.

## Decisions (locked)

- **Period = both.** Expose the candle timeframe (`klineInterval`, currently
  hardcoded `'1h'`) *and* the loop frequency (`loopIntervalMinutes`).
- **Apply = save + auto-restart.** On save, if the loop child is running,
  restart it so it re-reads config. If stopped, just persist; applies on next
  START.
- **Persistence = separate file.** Runtime settings live in
  `data/settings.json`. `.env` stays for secrets only.
- **Scope = all tunables** (LLM, period, sizing/risk, entry filters, symbols,
  daily limits).
- **Secrets/live = not exposed.** API keys and the LIVE-mode toggle are never
  editable from the UI. Provider choices are limited to providers whose API key
  is present in `.env`. Dashboard stays dryrun-only.

## Architecture

### Config resolution (the key mechanism)

`config.ts` is the single chokepoint: both the dashboard server process and the
spawned loop child import it, and it runs `dotenv.config()` then `loadConfig()`.

`loadConfig()` will, **after** `dotenv.config()`, overlay `data/settings.json`
on top of `process.env` (settings win) before the zod parse. Result: the loop
child, which is a fresh `node ts-node src/cli.ts dryrun` process, automatically
picks up the saved settings at boot. No spawn-env plumbing required.

Rejected alternative: injecting settings as env vars in `LoopController.spawn`.
Only the loop would get them; the server display would need a separate read;
and it still requires a settings→ENV_VAR name mapping. The overlay is a single
source of truth.

### Components

1. **`src/config/settings-store.ts`** (new)
   - `SETTINGS_SCHEMA` (zod): the whitelist of editable fields — a subset of
     `trading` plus LLM provider/model. Secrets, `understandRisks`, `mode`,
     `dbPath`, and all `dashboard.*` fields are **excluded** and never writable.
   - `readSettings(): Partial<Settings>` — reads `data/settings.json`; returns
     `{}` if the file is absent.
   - `writeSettings(partial): Settings` — validates against `SETTINGS_SCHEMA`,
     merges over existing, persists to `data/settings.json`. Unknown keys
     (including secrets) are stripped, not just ignored.
   - `settingsToEnv(settings): Record<string,string>` — maps canonical setting
     keys to the `process.env` slot names `loadConfig()` reads, used by the
     overlay.

2. **`src/config/config.ts`**
   - In `loadConfig()`: after `dotenv.config()`, apply
     `settingsToEnv(readSettings())` over `process.env` before building the raw
     values object for zod.
   - Add `trading.klineInterval`: `z.enum(['15m','30m','1h','4h','12h'])`,
     default `'1h'`, sourced from `process.env.KLINE_INTERVAL`.

3. **`src/strategy/market-data.ts`** — use `config.trading.klineInterval`
   instead of the hardcoded `'1h'`. `regime.ts` keeps its `'1d'` macro
   timeframe (out of scope).

4. **`src/dashboard/server.ts`**
   - `GET /api/settings` → effective values + meta: which providers have a key
     present, and the allowed enums/ranges per field (derived from the schema)
     so the UI can render selects and bounds.
   - `POST /api/settings` → validate via `SETTINGS_SCHEMA`; on success write
     `data/settings.json`; if `controller.isRunning()`, call
     `controller.restart()`. Respond `{ ok, restarted }`. On validation failure
     respond `400` with field error messages.

5. **`src/dashboard/loop-controller.ts`** — add `restart()`: stop the child,
   wait for exit, start again. No-op-safe if not running (just start).

6. **UI — `index.html` / `app.js` / `styles.css`**
   - A ⚙ button in the control bar opens a slide-over settings panel (same
     pattern as the existing log drawer).
   - Grouped form: **LLM** (provider select limited to keyed providers, model
     text) · **Período** (klineInterval select, loopIntervalMinutes) ·
     **Sizing & risco** (sizingMode, amountUsd, riskPctPerTrade, atrMultiplier,
     accountEquityUsd) · **Filtros** (minConfidence, minRrRatio,
     cooldownMinutes) · **Símbolos** (csv) · **Limites diários**
     (maxDailyLossPct, maxDailyLosses, maxPortfolioHeatPct).
   - Save → `POST /api/settings`. Inline field errors on 400; on success a
     toast/line noting whether the loop was restarted.

7. **Display freshness** — `stats-reader` reads provider/model **live** from
   `settings-store` (merged with defaults) for the snapshot's `llm` field,
   instead of the server's frozen `config`, so the KPI reflects a change
   without restarting the server process.

## Editable fields & validation (whitelist)

| Field | Type / bounds | Default |
|---|---|---|
| `llmProvider` | enum, keyed providers only | from env |
| `llmModel` | string | per-provider default |
| `klineInterval` | enum 15m/30m/1h/4h/12h | 1h |
| `loopIntervalMinutes` | number ≥ 1 | 15 |
| `sizingMode` | fixed/risk/atr | fixed |
| `amountUsd` | number > 0, ≤ 200 | 50 |
| `riskPctPerTrade` | 0.1–5 | 1 |
| `atrMultiplier` | 0.5–10 | 2 |
| `accountEquityUsd` | number > 0 | 1000 |
| `minConfidence` | 0–100 | 70 |
| `minRrRatio` | ≥ 1 | 2 |
| `cooldownMinutes` | ≥ 0 | 30 |
| `symbols` | csv of pairs | BTCUSDT,ETHUSDT,SOLUSDT |
| `maxDailyLossPct` | 0–100 | 3.0 |
| `maxDailyLosses` | int ≥ 1 | 3 |
| `maxPortfolioHeatPct` | 0–50 | 6 |

Bounds reuse the existing `ConfigSchema.trading` constraints; `SETTINGS_SCHEMA`
mirrors them so server and loop validate identically.

## Data flow

1. Page load → `GET /api/settings` → render form with current values +
   constraints + keyed-provider list.
2. Edit → Save → `POST /api/settings` → server validates → writes
   `data/settings.json` → restarts loop if running → child reboots → `config.ts`
   overlays settings.json → new behavior. Server returns `{ ok, restarted }`.
3. `data/settings.json` is under `data/`, already gitignored.

## Error handling

- Invalid values → zod errors → `400` with per-field messages → UI shows inline.
- File write failure → `500`.
- Provider without key posted → rejected server-side (defense beyond the UI
  filtering).
- Secrets / `mode=live` / `understandRisks` posted → stripped by the whitelist;
  never persisted.

## Security

- Server-side whitelist is authoritative; the UI filtering is convenience only.
- API keys and LIVE mode are never writable from the dashboard.
- A provider is selectable only if its API key exists in `.env`.
- `LoopController.spawn` already forces `TRADE_MODE=dryrun` — kept as defense in
  depth.

## Testing

- **settings-store:** defaults when no file; write+read roundtrip; reject
  invalid (zod); whitelist strips unknown/secret keys.
- **config overlay:** settings.json overrides env; absent file → env defaults;
  `klineInterval` resolves from settings.
- **market-data:** uses `config.trading.klineInterval`.
- **server:** `GET` returns effective values + provider availability; `POST`
  validates, writes, and triggers `restart()` when running (mock controller);
  `POST` with invalid/secret fields → 400/stripped.
- **loop-controller:** `restart()` stops then starts; safe when not running.

## Out of scope

- Editing API keys or enabling LIVE mode from the UI.
- Making `regime.ts` timeframe configurable.
- Multi-user auth on the dashboard.
