# Paper Trading Dashboard — Design Spec

Date: 2026-05-24
Branch: `feat/mvp-paper-trading`

## Goal

A single-user web dashboard, deployed on a VPS, that lets the operator:

1. View live status of the paper-trading loop (running / stopped, uptime, last tick).
2. Start and stop the loop with one click.
3. See current equity, KPIs, open positions with live PnL, closed-trade history, recent Claude decisions, equity curve, daily-gate status, and accumulated LLM cost.
4. Tail the loop's stdout/stderr in a collapsible drawer.

Scope is deliberately narrow: **dryrun only**, **no auth**, **no runtime config editing**, **no manual trade close**. Intended for paper-trading validation on a personal VPS.

## Non-goals

- Live mode toggle (hard-coded `TRADE_MODE=dryrun` on spawn — defense in depth).
- Multi-user, login, RBAC.
- Mobile layout (single operator on a desktop).
- Backtest UI (CLI is sufficient).
- Editing config at runtime (env file + restart is enough).
- Manual trade close from UI.

## Security posture

User chose no auth, "only I know the path." Acknowledged risks:

- VPS IPs are scanned constantly. Path obscurity is not security.
- Blast radius is limited because scope is start/stop of a **dryrun** loop only — no money movement, no live orders.
- If scope ever expands to `live` mode, auth becomes mandatory.

Recommended (out-of-band) mitigations the operator should apply:
- `ufw allow from <home-ip> to any port 8787` (firewall to a known IP).
- Or bind `DASHBOARD_HOST=127.0.0.1` and use an SSH tunnel (`ssh -L 8787:localhost:8787 vps`).
- Optional `DASHBOARD_PATH_PREFIX=/dash-<random>` for a secret path.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  trade-dashboard.service (systemd, single PID)  │
│                                                 │
│  ┌──────────────────────────────────────────┐  │
│  │  src/dashboard/server.ts (Node http)     │  │
│  │  Routes:                                 │  │
│  │   GET  /                → HTML           │  │
│  │   GET  /api/stream      → SSE 15s + log  │  │
│  │   GET  /api/status      → JSON snapshot  │  │
│  │   POST /api/start       → spawn child    │  │
│  │   POST /api/stop        → SIGTERM child  │  │
│  │   GET  /api/logs?n=200  → ring buffer    │  │
│  │                                          │  │
│  │  LoopController          StatsReader     │  │
│  │  (spawn/kill child,     (SQLite RO +     │  │
│  │   PID file, ring buf)    Binance prices) │  │
│  └─────────────┬────────────────────────────┘  │
│                ▼                                │
│  ┌──────────────────────┐                      │
│  │ child process:       │                      │
│  │  ts-node src/cli.ts  │                      │
│  │  dryrun              │                      │
│  │  writes → SQLite     │                      │
│  └──────────────────────┘                      │
└─────────────────────────────────────────────────┘
```

Single systemd unit. Dashboard server is parent, loop is child. Dashboard never writes to the DB — only reads. The bot writes.

## Module layout

```
src/dashboard/
  server.ts              # http server, route table, SSE wiring
  loop-controller.ts     # spawn/kill child, PID file, status, log ring buffer
  stats-reader.ts        # SQLite queries (uses shared collector)
  binance-prices.ts      # cached price fetcher for open-trade PnL (15s TTL)
  llm-cost.ts            # SUM(llm_input_tokens, llm_output_tokens) from decisions
                         # × hard-coded price table per CLAUDE_MODEL (USD/MTok)
  types.ts               # DashboardSnapshot, LoopStatus, etc.
  index.html             # single-page static
  app.js                 # frontend: EventSource + fetch + render
  styles.css             # editorial (Fraunces + JetBrains Mono, paleta de stats.ts)
src/stats/
  collect.ts             # extracted from src/scripts/stats.ts — collectStats + addOpenPnl
                         # consumed by both stats.ts CLI and dashboard
```

Extracting `collectStats` and `addOpenPnl` from `src/scripts/stats.ts` into a shared module is part of this work. The existing `stats.ts` script imports them from the new location after extraction — no behavior change to the CLI.

## API contract

### `GET /api/status` — JSON snapshot

```json
{
  "loop": {
    "running": true,
    "pid": 12345,
    "startedAt": 1716549200000,
    "uptimeSec": 3600,
    "lastTickAt": 1716552600000,
    "adopted": false
  },
```

`lastTickAt` is derived from `MAX(ts)` across the `decisions` table for the current strategy — that is the freshest evidence that the loop completed a cycle. (If no decisions yet, `null`.)

```json
  "stats": {
    "strategyName": "ema_rr2_paper_v1",
    "windowStart": 1715944800000,
    "windowEnd": 1716552800000,
    "startingEquity": 1000,
    "equityNow": 1042.50,
    "realizedPnlQuote": 42.50,
    "realizedPnlPct": 4.25,
    "openPnlQuote": 3.10,
    "winRateTotal": 0.62,
    "winRateBuy": 0.65,
    "winRateSell": 0.55,
    "winsBuy": 13, "totalBuy": 20,
    "winsSell": 3,  "totalSell": 5,
    "maxDdPct": 2.1,
    "avgHoldingMinutes": 180,
    "avgRrRatio": 2.3,
    "tradesClosed": 25,
    "tradesOpen": 2,
    "dailyGate": { "allowed": true, "reason": null, "ddPct": 0.5, "streak": 0 }
  },
  "openTrades":   [ { "id":1, "ts":..., "symbol":"BTCUSDT", "side":"BUY", "qty":0.001, "entry":67500, "currentPrice":68100, "pnlQuote":0.6, "pnlPct":0.89, "strategyName":"..." } ],
  "closedTrades": [ "...50 most recent..." ],
  "decisions":    [ "...20 most recent..." ],
  "equityCurve":  [ { "ts": 1715944800000, "equity": 1000.0 } ],
  "llmCost": { "totalUsd": 0.42, "inputTokens": 120000, "outputTokens": 8500, "byModel": { "claude-opus-4-7": 0.42 } }
}
```

### `GET /api/stream` — Server-Sent Events

Events:

```
event: snapshot
data: { <same DashboardSnapshot as /api/status> }

event: log
data: { "ts": 1716552800100, "stream": "stdout", "line": "[orchestrator] BTCUSDT: HOLD (confidence 65)" }

event: loop
data: { "running": false, "reason": "exited code=0" }
```

- `snapshot` every 15s.
- `log` in real time as the child emits lines.
- `loop` when the child dies or is spawned.
- Keepalive comment `:\n\n` every 20s to defeat proxy idle timeouts.

### `POST /api/start`

Body: `{}`. Responses:
- `200 { "ok": true, "pid": 12345 }` on spawn.
- `409 { "ok": false, "reason": "already running" }` if already running.
- `500 { "ok": false, "reason": "<message>" }` on spawn failure.

### `POST /api/stop`

Body: `{}`. Sends SIGTERM. Waits up to 5s for exit; if still alive, sends SIGKILL. Returns `200 { "ok": true }` after exit confirmed.

### `GET /api/logs?n=200`

Returns the last N lines of the ring buffer (capped at 500). Used for the log drawer cold-load on page F5.

## Process model

### Spawning

```typescript
const child = spawn(process.execPath, [
  require.resolve('ts-node/dist/bin'),
  'src/cli.ts', 'dryrun'
], {
  cwd: projectRoot,
  env: { ...process.env, TRADE_MODE: 'dryrun' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false,
});
fs.writeFileSync('data/loop.pid', String(child.pid));
child.stdout.on('data', chunk => ringPush(chunk.toString()));
child.stderr.on('data', chunk => ringPush(chunk.toString()));
child.on('exit', (code, sig) => { /* clear pid file, emit loop event */ });
```

- `detached: false`: the child dies if the parent dies. Single systemd unit; `Restart=on-failure` on the dashboard handles parent crashes.
- `TRADE_MODE=dryrun` injected in env: even if `.env` is misconfigured to `live`, the child boots in dryrun.

### Stopping

```typescript
async stop(): Promise<{ ok: boolean }> {
  if (!this.child) return { ok: true };
  this.child.kill('SIGTERM');
  const ok = await waitForExit(this.child, 5000);
  if (!ok) this.child.kill('SIGKILL');
  return { ok: true };
}
```

The loop (`src/loop.ts`) needs a SIGTERM handler that clears the recursive `setTimeout`, closes the SQLite DB, and exits 0. If one is missing, adding it is part of this work. Acceptance: SIGTERM finalizes in under 2s, no half-open trade left behind.

### Recovery after dashboard restart

```typescript
recoverFromPidFile() {
  if (!fs.existsSync('data/loop.pid')) return;
  const pid = parseInt(fs.readFileSync('data/loop.pid', 'utf8'), 10);
  try {
    process.kill(pid, 0);                 // throws if dead
    this.adoptedPid = pid;
    this.startedAt = fs.statSync('data/loop.pid').mtimeMs;
  } catch {
    fs.unlinkSync('data/loop.pid');       // stale
  }
}
```

When a loop is adopted (the dashboard didn't spawn it itself), the UI shows a yellow banner: "Loop adopted from PID file. Logs unavailable until restart. STOP still works." STOP works because Linux signals only require user match, not parent/child.

### Single-instance guard

On boot, the dashboard writes `data/dashboard.pid`. If the file exists and the PID is alive, exit 1 with an error. Prevents two dashboards racing for the same `loop.pid`.

## Frontend layout

Editorial language carried over from `src/scripts/stats.ts`: Fraunces serif + JetBrains Mono + palette `#0a0a0a / #f5f1e8 / #7cff6b / #ff5b5b`. New additions: a sticky control bar at top and a collapsible log drawer at bottom-right.

```
┌──────────────────────────────────────────────────────────────────┐
│  TRADE · paper                          [● running 2h 14m] [STOP]│  sticky top
├──────────────────────────────────────────────────────────────────┤
│  EQUITY                                Δ SINCE START             │
│  $1,042.50                             +$42.50  (+4.25%)         │
│  strategy: ema_rr2_paper_v1            DAILY GATE: OK            │
├──────────────────────────────────────────────────────────────────┤
│  KPI grid (Trades closed / Open / Win rate / Win rate buy /      │
│  Win rate sell / Max DD / Avg holding / Avg R/R / Open PnL /     │
│  LLM cost)                                                       │
├──────────────────────────────────────────────────────────────────┤
│  EQUITY CURVE (Chart.js line, no axes labels noise)              │
├──────────────────────────────────────────────────────────────────┤
│  OPEN POSITIONS (live PnL)                                       │
├──────────────────────────────────────────────────────────────────┤
│  RECENT DECISIONS (last 20, includes HOLD + skip_reason)         │
├──────────────────────────────────────────────────────────────────┤
│  CLOSED TRADES (scroll-paginated, 50 at a time)                  │
└──────────────────────────────────────────────────────────────────┘
  [▣ logs] ← bottom-right toggle; expands a drawer with tail.
```

Control bar dot: green when running, gray when stopped, red on errored exit. Button shows START or STOP depending on state. STOP swaps inline for "Confirm? [yes] [cancel]" for 5s before sending. START has no confirmation (reversible, low blast).

Log drawer auto-tails when open; user scrolling up pauses auto-tail until they return to bottom.

Min-width 720px. No mobile layout.

The `frontend-design` skill will polish typography, spacing, microinteractions during implementation; this spec fixes only structure and content.

## Env vars (new)

```
DASHBOARD_PORT=8787              # default; uncommon port, low collision
DASHBOARD_HOST=0.0.0.0           # use 127.0.0.1 if behind an SSH tunnel
DASHBOARD_PATH_PREFIX=           # optional, e.g. "/dash-x7k9q2"
DASHBOARD_AUTOSTART_LOOP=false   # if true, dashboard spawns the loop on boot
```

All validated via zod in `src/config/config.ts`.

## npm script

```json
"dashboard": "ts-node src/dashboard/server.ts"
```

## systemd unit

`ops/trade-dashboard.service`:

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

Replaces `trade.service`. README updated with:

```bash
sudo systemctl disable --now trade.service
sudo systemctl enable --now trade-dashboard.service
# access: http://<vps-ip>:8787
```

## Tests (vitest)

- `loop-controller.spec.ts` — spawn a fake child (`/bin/sleep 60`); assert PID file is written; assert STOP kills it; assert recovery adopts a live PID and cleans a stale one.
- `stats-reader.spec.ts` — seed an isolated SQLite DB with fixtures; assert the snapshot shape and KPI math.
- `server.spec.ts` — supertest against the HTTP server; assert routes, status codes, and SSE handshake.
- No browser E2E (overkill for a single page).

## Acceptance criteria

- [ ] `npm run dashboard` boots the server on `:8787`.
- [ ] `http://localhost:8787` renders the dashboard.
- [ ] START spawns the child; status flips to running; log stream flows in real time.
- [ ] STOP terminates the child within 5s; status flips to stopped.
- [ ] Page reload preserves state (reads `data/loop.pid`).
- [ ] `kill -9` of the dashboard → systemd restart → adopts PID from file; UI marks the loop "adopted".
- [ ] 24h continuous run with no memory leak (log ring buffer capped at 500 lines).
- [ ] SIGTERM to the child finalizes in <2s with no half-open trade.

## Anti-goals (explicit)

- No multi-user.
- No live mode (hard-coded dryrun in the spawn env).
- No runtime config editing.
- No manual trade close.
- No auth (relying on path obscurity + firewall, per operator's choice).
- No mobile layout.
- No backtest UI.
