# Trade Bot — Claude + Binance

Plano de implementação do novo projeto. Baseado em lições do `cripto-deepseek`.

## Objetivo

Bot de trading spot na Binance que usa Claude (via `@anthropic-ai/sdk`) como decisor, com indicadores técnicos como pré-filtro e validação rígida de risk/reward antes de executar ordens reais.

## Princípios

1. **Dry-run por padrão.** `--live` é opt-in explícito.
2. **Decisão estruturada via tool use.** Claude responde JSON validado por zod, nunca parsing de texto livre.
3. **1 estratégia, config-driven.** Não 11 bots paralelos.
4. **Backtest obrigatório antes de live.** Sem backtest, sem capital real.
5. **Camada única de validação R/R + cooldown.** Centralizada no executor.

## Stack

- Runtime: Node 20+ (TypeScript)
- Package manager: pnpm
- Libs:
  - `@anthropic-ai/sdk` — Claude
  - `axios` — HTTP Binance
  - `better-sqlite3` — persistência local
  - `zod` — validação de schema (decisões, config, env)
  - `dotenv` — env vars
  - `commander` — CLI

Sem `node-cron`. Usar systemd timer ou cron OS.

## Estrutura

```
src/
  binance/
    public-client.ts          # portado do antigo, sem mudança
    private-client.ts         # portado, + cancel order, + getSymbolInfo
    types.ts                  # Kline, Order, Balance, SymbolFilters
  indicators/
    ema.ts                    # cálculo puro, sem decisão
    rsi.ts                    # opcional fase 2
    index.ts                  # exports
  llm/
    claude-client.ts          # wrapper sdk + retry
    prompt.ts                 # system prompt + user template
    tools.ts                  # tool definition: decide_trade
    schema.ts                 # zod schema da decisão
  strategy/
    orchestrator.ts           # indicators → claude → validação
    market-data.ts            # monta payload p/ Claude (klines, ticker, book)
  executor/
    trade-executor.ts         # cooldown, balance, market order, OCO
    risk-manager.ts           # R/R dinâmico, validação min 2:1
    cooldown.ts               # state em SQLite, não memória
  storage/
    db.ts                     # better-sqlite3 setup + migrations
    trades.ts                 # CRUD trades
    decisions.ts              # log decisões Claude (auditoria)
  backtest/
    engine.ts                 # replay klines históricos
    metrics.ts                # win rate, PnL, max drawdown, Sharpe
  config/
    config.ts                 # zod-validated env + defaults
    symbols.ts                # whitelist + filtros por símbolo
  cli.ts                      # commander: dry-run | live | backtest | status
  index.ts
.env.example
package.json
tsconfig.json
README.md
```

## Schema de decisão (Claude tool use)

```typescript
const TradeDecision = z.object({
  action: z.enum(['BUY', 'SELL', 'HOLD']),
  confidence: z.number().min(0).max(100),
  reason: z.string().max(500),
  stopLossPercent: z.number().min(0.5).max(10),
  takeProfitPercent: z.number().min(1).max(20),
  timeHorizonMinutes: z.number().min(5).max(1440),
});
```

Tool definition entregue ao Claude. Resposta sempre válida ou trade abortado.

## Fluxo de execução (live)

```
1. CLI: trade live --symbols BTCUSDT,ETHUSDT --amount 50
2. Loop a cada N min:
   a. para cada símbolo:
      - busca klines (1h, 100 períodos), ticker 24h, top order book
      - calcula EMA9/EMA21
      - se EMA não confirma trend → skip (economiza chamada LLM)
   b. monta payload + chama Claude com tool decide_trade
   c. valida schema (zod). Se inválido → log + skip
   d. valida confidence ≥ MIN_CONFIDENCE (default 70)
   e. valida R/R ratio ≥ 2:1 (TP% / SL%)
   f. checa cooldown (último trade no símbolo > 30min)
   g. checa saldo USDT/asset suficiente
   h. executa MARKET order
   i. cria OCO (TP + SL); fallback LIMIT TP se OCO falha
   j. persiste em SQLite: decision, order, fills, oco_ids
3. Tratamento de erro: log + continua próximo símbolo, nunca crashar
```

## Fluxo backtest

```
1. CLI: trade backtest --symbol BTCUSDT --from 2025-01-01 --to 2025-04-01
2. Baixa klines históricos (paginação Binance)
3. Replay: para cada candle, simula passo do fluxo live (sem ordem real)
4. Persiste trades simulados em SQLite (tabela separada)
5. Imprime métricas: trades, win rate, PnL%, max drawdown, R/R médio
```

Importante: backtest com LLM real é caro. Modo `--llm mock` usa heurística (EMA cross + R/R fixo) para iteração rápida; modo `--llm claude` para validação final.

## Schema SQLite

```sql
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  action TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT,
  stop_loss_pct REAL,
  take_profit_pct REAL,
  llm_input_tokens INTEGER,
  llm_output_tokens INTEGER,
  llm_cost_usd REAL,
  executed INTEGER NOT NULL DEFAULT 0,
  skip_reason TEXT
);

CREATE TABLE trades (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER REFERENCES decisions(id),
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  avg_price REAL NOT NULL,
  quote_qty REAL NOT NULL,
  binance_order_id TEXT NOT NULL,
  oco_order_list_id TEXT,
  tp_price REAL,
  sl_price REAL,
  status TEXT NOT NULL,        -- OPEN | TP_FILLED | SL_FILLED | CANCELED | ERROR
  closed_ts INTEGER,
  closed_price REAL,
  pnl_quote REAL,
  pnl_pct REAL,
  mode TEXT NOT NULL           -- live | dryrun | backtest
);

CREATE TABLE cooldowns (
  symbol TEXT PRIMARY KEY,
  last_trade_ts INTEGER NOT NULL
);
```

## Config / env

```
# .env.example
BINANCE_API_KEY=
BINANCE_API_SECRET=
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-sonnet-4-6
TRADE_MODE=dryrun                # dryrun | live
TRADE_AMOUNT_USD=50
MIN_CONFIDENCE=70
MIN_RR_RATIO=2.0
COOLDOWN_MINUTES=30
SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
LOOP_INTERVAL_MINUTES=15
```

Tudo validado por zod em `config/config.ts`. App não inicia sem env obrigatórios.

## Segurança

- API key Binance: criar com permissão **spot trading apenas**, sem withdraw, com IP whitelist.
- Secret nunca logado, nunca commitado. `.env` em `.gitignore`.
- `--live` exige variável `I_UNDERSTAND_RISKS=yes` setada na sessão. Friction proposital.
- Limite hard-coded de `MAX_TRADE_AMOUNT_USD=200` no código. Quer mais? Edita o código.
- Rate limiting: respeitar `X-MBX-USED-WEIGHT` header da Binance. Backoff exponencial em 429/418.

## Tasks (ordem de implementação)

### Fase 1 — Fundação
1. Init projeto: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `README.md`
2. `config/config.ts` com zod + carregamento .env
3. `binance/public-client.ts` portado + types
4. `binance/private-client.ts` portado + cancel order + getSymbolInfo
5. Testes manuais: `bin/test-binance-public`, `bin/test-binance-private` (ler saldo, sem ordem)

### Fase 2 — Storage + indicadores
6. `storage/db.ts` setup + migrations
7. `storage/trades.ts`, `storage/decisions.ts`
8. `indicators/ema.ts` portado do antigo

### Fase 3 — Claude
9. `llm/schema.ts` (zod TradeDecision)
10. `llm/tools.ts` (Anthropic tool definition)
11. `llm/prompt.ts` (system + user template)
12. `llm/claude-client.ts` com tool use + retry + custo

### Fase 4 — Estratégia + execução
13. `strategy/market-data.ts` (monta payload p/ Claude)
14. `strategy/orchestrator.ts` (EMA pre-filter → Claude → validação)
15. `executor/risk-manager.ts` (R/R dinâmico)
16. `executor/cooldown.ts` (SQLite-backed)
17. `executor/trade-executor.ts` (balance, market, OCO, fallback)

### Fase 5 — CLI + modos
18. `cli.ts` com commander: `dryrun`, `live`, `status`
19. Loop interval com `setTimeout` recursivo (não setInterval — evita overlap)
20. Logs estruturados (timestamp, symbol, action, level)

### Fase 6 — Backtest
21. `backtest/engine.ts` (download klines + replay)
22. `backtest/metrics.ts` (win rate, PnL, drawdown)
23. CLI subcommand `backtest`
24. Modo `--llm mock` para iteração rápida

### Fase 7 — Operação
25. systemd unit ou cron entry de exemplo no README
26. Script de monitoramento (lê SQLite, imprime PnL acumulado, trades abertos)
27. Alerta simples (webhook Discord/Telegram) em trades executados e erros críticos

## Critérios de "pronto"

- [ ] `pnpm test-binance-private` lê saldo sem erro
- [ ] `pnpm dryrun` roda 24h sem crash, decisões logadas em SQLite
- [ ] Backtest de 90 dias em 3 símbolos com win rate ≥ 50% e R/R médio ≥ 2:1
- [ ] Modo `live` testado com `TRADE_AMOUNT_USD=10` durante 1 semana
- [ ] Doc README com setup, env, comandos, riscos

## Anti-objetivos (não fazer)

- Suporte a futures/margin (só spot)
- Múltiplos exchanges (só Binance)
- UI web (CLI + SQLite é suficiente)
- Auto-tuning de hiperparâmetros via LLM
- Strategies copiadas em 11 arquivos
