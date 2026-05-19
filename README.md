# trade

Spot trading bot for Binance using Claude (`@anthropic-ai/sdk`) as the decision layer with EMA pre-filtering, strict risk/reward validation, and OCO bracket orders.

## Risk warning

This bot can place real orders on Binance with real money. Read every line you run.

- Default mode is `dryrun` (no real orders).
- `live` mode requires `I_UNDERSTAND_RISKS=yes` in `.env`.
- Hard cap of `MAX_TRADE_AMOUNT_USD=200` enforced in code.
- Use a Binance API key with **spot trading only**, withdraw disabled, IP whitelisted.
- Run a backtest of 90+ days before any live capital.

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
npm run backtest -- --symbol BTCUSDT --from 2025-01-01 --to 2025-04-01 --llm mock
npm run status                    # read SQLite, print open trades + PnL
npm run monitor                   # live status refresh every 5s
```

## Architecture

```
src/
  binance/         # public + private REST clients
  indicators/      # EMA (pre-filter)
  llm/             # Claude client, tool definition, prompt, zod schema
  strategy/        # orchestrator: indicators → claude → validation
  executor/        # risk manager, balance, MARKET order, OCO bracket
  storage/         # SQLite (decisions, trades, cooldowns)
  backtest/        # paged kline download + replay + metrics
  config/          # zod-validated env
  cli.ts           # commander entry
  loop.ts          # recursive setTimeout runner
  logger.ts        # structured logging
  notifier.ts      # Discord/Telegram webhooks
```

### Decision flow per symbol

```
cooldown check → klines + ticker + book → EMA pre-filter (skip if no trend)
  → Claude tool use (decide_trade) → zod validate → R/R ≥ MIN_RR_RATIO
  → confidence ≥ MIN_CONFIDENCE → balance check → MARKET order
  → OCO (TP + SL), fallback LIMIT TP → persist to SQLite → set cooldown
```

### Modes

- **dryrun** — full pipeline runs, decisions logged to SQLite, no real orders. Recommended default.
- **live** — places real MARKET + OCO orders on Binance. Requires `I_UNDERSTAND_RISKS=yes`.
- **backtest** — replays historical klines through the strategy. Use `--llm mock` for cheap iteration, `--llm claude` for final validation.

## Backtest

```bash
npm run backtest -- \
  --symbol BTCUSDT \
  --from 2025-01-01 \
  --to 2025-04-01 \
  --llm mock \
  --interval 1h
```

Mock LLM uses heuristic decisions (~$0 cost). Use `--llm claude` for real Claude calls (expensive — budget accordingly).

Metrics reported: win rate, total PnL, profit factor, max drawdown, avg R/R achieved, Sharpe.

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

See `.env.example`. All validated by zod at startup — app refuses to start with invalid config (or skips API-key validation when not used, e.g. backtest mock).

## Stack

- TypeScript (Node 20+)
- `@anthropic-ai/sdk` — Claude with tool use, adaptive thinking, prompt caching
- `axios` — Binance REST
- `better-sqlite3` — local persistence (WAL mode)
- `zod` — schema validation
- `commander` — CLI

## License

ISC
