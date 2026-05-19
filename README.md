# trade

Spot trading bot for Binance using Claude (`@anthropic-ai/sdk`) as the decision layer. EMA pre-filtering, macro regime context, risk-based position sizing, portfolio heat caps, strict R/R validation, OCO bracket orders, automated postmortem with MAE/MFE.

## Risk warning

This bot can place real orders on Binance with real money. Read every line you run.

- Default mode is `dryrun` (no real orders).
- `live` mode requires `I_UNDERSTAND_RISKS=yes` in `.env`.
- Hard cap of `MAX_TRADE_AMOUNT_USD=200` enforced in code.
- `MAX_PORTFOLIO_HEAT_PCT` caps total open risk across all positions.
- Use a Binance API key with **spot trading only**, withdraw disabled, IP whitelisted.
- Run a backtest of 90+ days **with slippage modeled** before any live capital. Aim for `DEPLOY` verdict, not `REFINE`/`ABANDON`.

You are responsible for losses. Crypto markets can go to zero.

## Setup

```bash
npm install
cp .env.example .env
# fill BINANCE_API_KEY, BINANCE_API_SECRET, ANTHROPIC_API_KEY
```

Node 20+ required.

## Commands

```bash
npm run test-binance-public       # smoke test public endpoints (no auth)
npm run test-binance-private      # smoke test signed endpoints (reads balance)
npm run test-claude               # smoke test Anthropic SDK + tool use

npm run dryrun                    # run strategy loop, log decisions, no orders
npm run live                      # run strategy loop with real orders (requires I_UNDERSTAND_RISKS=yes)
npm run once -- --mode dryrun     # one cycle then exit (for cron)

npm run backtest -- --symbol BTCUSDT --from 2025-01-01 --to 2025-04-01 --llm mock --slippage 0.05
npx ts-node src/cli.ts sweep --symbol BTCUSDT --from 2025-01-01 --to 2025-04-01 \
  --param ema-fast --values 5,7,9,11,14 --llm mock

npm run status                    # SQLite snapshot: open trades + PnL + postmortems
npm run monitor                   # live status refresh every 5s
npx ts-node src/cli.ts close-trades --mode live      # detect filled OCOs, write postmortems
```

## Architecture

```
src/
  binance/         # public + private REST clients
  indicators/      # EMA + ATR
  llm/             # Claude client, tool definition, prompt, zod schema
  strategy/        # orchestrator + market-data + regime detector
  executor/        # risk manager, position sizer, balance, MARKET, OCO bracket
  postmortem/      # OCO-fill closer, classifies outcome, computes MAE/MFE
  storage/         # SQLite (decisions, trades, cooldowns, postmortems)
  backtest/        # paged kline download + replay + metrics + verdict
  config/          # zod-validated env
  cli.ts           # commander entry
  loop.ts          # recursive setTimeout runner
  logger.ts        # structured logging
  notifier.ts      # Discord/Telegram webhooks
```

### Decision flow per symbol

```
detectRegime (cached 15min)              ┐
cooldown check → snapshot (klines+ticker │
  +book+EMA+ATR) → EMA pre-filter ───────┤
  → Claude tool use (decide_trade) ──────┤
  → zod validate                         │
  → R/R ≥ MIN_RR_RATIO                   │── orchestrator
  → confidence ≥ MIN_CONFIDENCE          │
  → position-sizer (fixed | risk | atr)  │
  → portfolio-heat check                 │
  → balance check                        │
  → MARKET order → OCO (TP+SL)           │
  → persist to SQLite → set cooldown     ┘

every cycle (live mode):
  closer.runLive() → query Binance order history → match OCO closing fills
    → close trade → write postmortem (outcome + MAE/MFE + classification)
```

### Modes

- **dryrun** — full pipeline runs, decisions logged to SQLite, no real orders. Recommended default.
- **live** — places real MARKET + OCO orders on Binance. Requires `I_UNDERSTAND_RISKS=yes`.
- **backtest** — replays historical klines through the strategy. Use `--llm mock` for cheap iteration, `--llm claude` for final validation.

## Position sizing

`SIZING_MODE` env controls how trade size is calculated:

| Mode    | Formula                                                            | When to use                                              |
| ------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| `fixed` | `quote_qty = TRADE_AMOUNT_USD`                                     | Simplest. Same dollar exposure every trade.              |
| `risk`  | `qty = (equity × RISK_PCT_PER_TRADE) / stop_distance_usd`          | Constant dollar risk. Bigger size on tighter stops.      |
| `atr`   | `stop_distance = ATR(14) × ATR_MULTIPLIER`, then risk-based sizing | Volatility-adjusted stops. Best for variable regimes.    |

All modes hard-capped by `TRADE_AMOUNT_USD` and the global `MAX_TRADE_AMOUNT_USD=200`.

**Portfolio heat cap:** Before each new BUY, the executor sums prospective risk + current open-trade risk across all positions. If projected heat > `MAX_PORTFOLIO_HEAT_PCT` (default 6%), trade is skipped.

## Macro regime

Each cycle, before per-symbol decisions, the regime detector computes:

- BTC EMA50 slope on 1d klines (60d window)
- BTC 30d change %
- Fear & Greed Index from [alternative.me](https://alternative.me/crypto/fear-and-greed-index/) (free API, graceful degrade if unavailable)

Result classified as `RISK_ON | RISK_OFF | CHOPPY | UNKNOWN` and injected into Claude's user prompt. Claude is instructed to weight decisions accordingly (e.g., RISK_OFF biases toward HOLD; CHOPPY tightens confidence thresholds).

Regime cached for 15 minutes — one fetch per cycle, shared across symbols.

## Postmortems

Automated trade-closing + outcome recording.

**Live mode:** every loop cycle, `TradeCloser.runLive()` queries Binance `getOrderHistory` for each open trade's symbol. If a closing-side `FILLED` order is found after the trade's entry timestamp, the trade is closed with:

- Exit price = `cummulativeQuoteQty / executedQty`
- Outcome classification:
  - `TP_HIT` — exit within 0.2% of recorded TP
  - `SL_HIT` — exit within 0.2% of recorded SL
  - `MANUAL` — neither
- **MAE/MFE** — fetches 15m klines from entry→exit, computes max adverse (lowest favorable price for longs) and max favorable excursion
- Classification: `TRUE_POSITIVE` (TP), `FALSE_POSITIVE` (SL), `TIMEOUT_WIN`, `TIMEOUT_LOSS`

**Dryrun mode:** `TradeCloser.runDryrunTimeout(maxAgeHours)` closes trades older than N hours using current market price. Manual: `npx ts-node src/cli.ts close-trades --mode dryrun --max-age-hours 24`.

Postmortems land in `postmortems` table. Visible via `npm run status` (recent 10) or `monitor`.

## Backtest

```bash
npm run backtest -- \
  --symbol BTCUSDT \
  --from 2025-01-01 \
  --to 2025-04-01 \
  --llm mock \
  --interval 1h \
  --slippage 0.05
```

Mock LLM uses heuristic decisions (~$0 cost). Use `--llm claude` for real Claude calls (expensive — budget accordingly).

**Slippage** — `--slippage 0.05` applies 0.05% per side (entry + every exit type: TP, SL, TIMEOUT). Recommend 0.05-0.10% for liquid pairs, higher for thin altcoins. Setting `slippage > 0` flips the `executionRealism` dimension of the verdict to passing.

**Metrics:** win rate, total PnL, profit factor, max drawdown, avg R/R achieved, Sharpe, **year-by-year** breakdown.

**Verdict** — Deploy/Refine/Abandon scored across 5 dimensions (sample size, expectancy, risk management, robustness, execution realism). Red flags surfaced (small sample, negative expectancy, suspicious win rate, PF < 1, drawdown > 20%, year-fragile, no slippage).

### Parameter sweep

Find plateaus, not peaks:

```bash
npx ts-node src/cli.ts sweep \
  --symbol BTCUSDT --from 2025-01-01 --to 2025-04-01 \
  --param ema-fast --values 5,7,9,11,14 \
  --llm mock
```

Output table: `value | trades | win% | pnl% | profit_factor | max_dd% | verdict`. Look for ranges where verdict stays `DEPLOY` and metrics are stable across values — that's a plateau. A single value with great metrics surrounded by ABANDON is curve-fit.

Sweepable params: `ema-fast`, `ema-slow`, `slippage`.

## Notifications (optional)

Wire `DISCORD_WEBHOOK_URL` or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `.env`. Control which events trigger via `NOTIFY_ON`:

```
NOTIFY_ON=executed,error          # csv: executed | error | summary | skipped
```

No-op if not configured.

## Operations

### systemd (long-running loop)

```bash
sudo cp -r . /opt/trade
cd /opt/trade/ops
sudo ./install.sh
# place .env at /opt/trade/.env (chmod 600, owner=trade)
sudo systemctl enable --now trade.service
journalctl -u trade.service -f
```

See `ops/trade.service` for the unit file. Hardened with `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`.

### cron (single-cycle mode)

Alternative to a persistent process. Edit `ops/crontab.example`, install with `crontab -e`:

```cron
*/15 * * * * cd /opt/trade && flock -n /tmp/trade.lock node node_modules/ts-node/dist/bin.js src/cli.ts once --mode dryrun >> /opt/trade/logs/cron.log 2>&1
```

`flock` prevents overlap if a cycle runs long.

### Monitor

```bash
npm run monitor                   # refresh every 5s
npm run monitor -- --interval 10 --mode live
```

Renders open trades, PnL summary, and recent decisions.

## Env vars

| Var                       | Default              | Notes                                                                      |
| ------------------------- | -------------------- | -------------------------------------------------------------------------- |
| `BINANCE_API_KEY/SECRET`  | (empty)              | Required only for `live` mode and `test-binance-private`. Spot only, no withdraw, IP whitelist. |
| `ANTHROPIC_API_KEY`       | (empty)              | Required for live/dryrun/backtest (with `--llm claude`).                  |
| `CLAUDE_MODEL`            | `claude-opus-4-7`    | Override to `claude-sonnet-4-6` / `claude-haiku-4-5` for lower cost.       |
| `CLAUDE_EFFORT`           | `medium`             | `low \| medium \| high \| xhigh \| max`. `xhigh`/`max` are Opus-tier only. |
| `TRADE_MODE`              | `dryrun`             | `dryrun \| live \| backtest`.                                              |
| `TRADE_AMOUNT_USD`        | `50`                 | Quote qty when SIZING_MODE=fixed. Cap on other modes.                      |
| `SIZING_MODE`             | `fixed`              | `fixed \| risk \| atr`. See Position sizing section.                       |
| `RISK_PCT_PER_TRADE`      | `1.0`                | % of `ACCOUNT_EQUITY_USD` risked per trade (risk/atr modes).               |
| `ACCOUNT_EQUITY_USD`      | `1000`               | Used by risk/atr sizing + heat cap calc.                                   |
| `ATR_MULTIPLIER`          | `2.0`                | Stop distance = ATR(14) × multiplier (atr mode).                           |
| `MAX_PORTFOLIO_HEAT_PCT`  | `6.0`                | Cap total open risk across positions. Skips new BUY if exceeded.           |
| `MIN_CONFIDENCE`          | `70`                 | Claude decision threshold, 0-100.                                          |
| `MIN_RR_RATIO`            | `2.0`                | Min reward/risk. Enforced in Claude client AND executor.                   |
| `COOLDOWN_MINUTES`        | `30`                 | Min minutes between trades per symbol.                                     |
| `SYMBOLS`                 | `BTCUSDT,ETHUSDT,SOLUSDT` | csv.                                                                   |
| `LOOP_INTERVAL_MINUTES`   | `15`                 | Loop tick interval.                                                        |
| `I_UNDERSTAND_RISKS`      | `no`                 | Must be `yes` to enable `live` mode.                                       |
| `DB_PATH`                 | `./data/trade.db`    | SQLite path.                                                               |
| `LOG_LEVEL`               | `info`               | `debug \| info \| warn \| error`.                                          |
| `DISCORD_WEBHOOK_URL`     | (empty)              | Optional notifier sink.                                                    |
| `TELEGRAM_BOT_TOKEN`      | (empty)              | Optional notifier sink (requires `TELEGRAM_CHAT_ID`).                      |
| `NOTIFY_ON`               | `executed,error`     | csv: `executed \| error \| summary \| skipped`.                            |

All validated by zod at startup. API-key validation is lazy — backtest with `--llm mock` runs with no credentials.

## Stack

- TypeScript (Node 20+)
- `@anthropic-ai/sdk` — Claude with tool use, adaptive thinking, prompt caching
- `axios` — Binance REST + Fear&Greed API
- `better-sqlite3` — local persistence (WAL mode)
- `zod` — schema validation
- `commander` — CLI

## License

ISC
