# MVP — Paper Trading + Dashboard de Acertividade

**Data:** 2026-05-19
**Status:** Design aprovado, pendente revisão final do usuário antes de virar plano de implementação.

## Objetivo

Validar se o sistema **EMA9/21 pre-filter + Claude (IA) decisor** tem edge antes de comprometer capital real. Rodar paper-trading com banca virtual de **$1000 USDT** por ~2 semanas e medir win-rate, PnL, drawdown, win-rate por lado (buy/sell).

Sem framework composável de sinais, sem multi-timeframe, sem comparação multi-estratégia. Isso vira próximo spec **se** o MVP indicar edge.

## Princípios

1. **Patch mínimo no `dryrun` atual.** Não criar modo `paper` separado.
2. **Reuso de schema/código existente** sempre que possível.
3. **Win-rate confiável.** Fill simulator real baseado em candles 15m, não timeout de 48h.
4. **Tag de estratégia desde o dia 1.** `strategy_name` em cada trade/decision pra comparação futura sem migração retroativa.
5. **Dashboard como artefato manual.** Sem live-refresh, sem servidor. `npm run stats` regenera HTML quando quiser.

## Decisões locked (brainstorming)

| Decisão | Valor |
|---------|-------|
| Banca virtual | $1000 USDT (reusa `ACCOUNT_EQUITY_USD=1000`) |
| Símbolo | BTCUSDT |
| Pre-filter | EMA 9 sobre EMA 21 (1h) — código existente sem mudança |
| Decisor | Claude (existente) |
| Timeframe | 1h apenas |
| Daily gate | `MAX_DAILY_LOSS_PCT=3.0` **OU** `MAX_DAILY_LOSSES=3` (streak), o que acontecer primeiro |
| Stats | CLI + HTML estático em `data/stats.html` |
| Run mode | Manual (`npm run dryrun` em terminal aberto) |
| Janela alvo | ~2 semanas |

## Arquitetura

```
src/
  paper/                          [NOVO]
    fill-simulator.ts             # check TP/SL contra candles 15m desde entrada
    daily-gate.ts                 # gate de perda diária (3% DD OU 3 streak)
  scripts/
    stats.ts                      [NOVO] # CLI + gera data/stats.html
  storage/
    trades.ts                     # +coluna strategy_name (migration)
    decisions.ts                  # +coluna strategy_name (migration)
    db.ts                         # migrations adicionais
  postmortem/
    closer.ts                     # runDryrunTimeout → runDryrunFillSim
  strategy/
    orchestrator.ts               # chama daily-gate antes do pipeline
  executor/
    trade-executor.ts             # popula strategy_name no TradeRecord
  config/
    config.ts                     # +MAX_DAILY_LOSS_PCT, MAX_DAILY_LOSSES, STRATEGY_NAME
data/
  stats.html                      [NOVO, gerado, gitignored]
```

`.env.example` ganha:
```
MAX_DAILY_LOSS_PCT=3.0
MAX_DAILY_LOSSES=3
STRATEGY_NAME=ema9_21+claude_v1
DRYRUN_MAX_HOLD_HOURS=168          # fallback timeout (7 dias) p/ trades sem TP/SL hit
```

## Componentes

### 1. Fill Simulator (`src/paper/fill-simulator.ts`)

**Responsabilidade:** fechar trades dryrun com base em hits reais de TP/SL ao invés de timeout.

**Interface:**
```typescript
class FillSimulator {
  constructor(pub: BinancePublicClient);
  async runDryrunFillSim(): Promise<CloserResult>;
}
```

Substitui `TradeCloser.runDryrunTimeout()`. Mesma assinatura de retorno (`CloserResult`).

**Estratégia de refactor (única e consistente):**
- `closer.ts`: **remove** `runDryrunTimeout` e `tryCloseDryrunTimeout` (não usado mais). Mantém `runLive`, `tryCloseLive`, `classifyExit`, `computeMaeMfe`. **Exporta** `persistClose` como função utilitária livre (ex.: `paper/persist-close.ts`) ou via método público `TradeCloser.persistClose(...)`. Implementação prefere segunda opção (sem mover código, só visibility).
- `FillSimulator` (novo): construtor recebe `pub: BinancePublicClient` e `closer: TradeCloser`. Pra cada trade resolvido, chama `closer.persistClose(trade, exitPrice, closedTs, outcome)`.
- Loop principal (`loop.ts`): chama `fillSimulator.runDryrunFillSim()` no lugar do antigo `closer.runDryrunTimeout(...)`.

**Algoritmo por trade `OPEN` com `mode='dryrun'`:**

1. Busca klines 15m do símbolo de `trade.ts` até `Date.now()` (paginação se > 1000 candles).
2. Itera candles em ordem temporal:
   - **isLong (BUY):**
     - Se `candle.high >= trade.tpPrice` **e** `candle.low <= trade.slPrice` no mesmo candle (whipsaw):
       - Regra pessimista: assume **SL primeiro**. Outcome = `SL_HIT`. Postmortem `notes` recebe string `"AMBIGUOUS_SAME_CANDLE_15M"` pra auditoria.
     - Senão, se `candle.high >= tpPrice` → `TP_HIT` no `candle.closeTime`, `exitPrice = tpPrice`.
     - Senão, se `candle.low <= slPrice` → `SL_HIT` no `candle.closeTime`, `exitPrice = slPrice`.
   - **isShort (SELL):** análogo, `low <= tpPrice` para TP, `high >= slPrice` para SL.
3. Se nenhum hit em `DRYRUN_MAX_HOLD_HOURS` (default 168h = 7d): outcome `TIMEOUT`, `exitPrice = preço corrente`.
4. Chama `persistClose` existente em `closer.ts` (reusa, expõe método ou move pra util).

**Regra "SL antes de TP na mesma vela 15m"** é a convenção pessimista padrão de backtesting. Documentada no `notes` pra usuário reconciliar manualmente se quiser.

### 2. Daily Gate (`src/paper/daily-gate.ts`)

**Responsabilidade:** bloquear novas decisões quando perda diária excedida.

**Interface:**
```typescript
interface GateResult { allowed: boolean; reason?: string }
function checkDailyGate(): GateResult;
```

**Algoritmo:**

1. `start = today 00:00 UTC` (ms epoch).
2. Query: `SELECT pnl_quote, pnl_pct FROM trades WHERE closed_ts >= ? AND mode='dryrun' AND status IN ('TP_FILLED','SL_FILLED','CANCELED') ORDER BY closed_ts`.
3. Drawdown:
   ```
   negPnlSum = sum(pnl_quote where pnl_quote < 0)
   ddPct = abs(negPnlSum) / config.trading.accountEquityUsd * 100
   if (ddPct >= MAX_DAILY_LOSS_PCT) → block
   ```
4. Streak: iterar trades em ordem cronológica reversa, contar consecutivas com `pnl_quote < 0` até primeira positiva. Se streak `>= MAX_DAILY_LOSSES` → block.
5. Caso contrário → allow.

**Chamada:** primeira coisa no `orchestrator.ts` antes do EMA filter. Loop segue rodando, decisões puladas até next UTC midnight.

Log na primeira vez que bloqueia no dia: `"Daily gate hit: 3.2% DD today (cap 3.0%). Pausing decisions until UTC midnight."` Depois disso, log throttled (1 vez por hora) pra não poluir.

### 3. Strategy name tag

**Migration (`storage/db.ts`):**
```sql
ALTER TABLE trades ADD COLUMN strategy_name TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE decisions ADD COLUMN strategy_name TEXT NOT NULL DEFAULT 'unknown';
```

Migration idempotente: usar `PRAGMA table_info` pra checar coluna antes de adicionar.

**Wiring:**
- `config.ts`: lê `STRATEGY_NAME` env, expõe `config.trading.strategyName`.
- `trade-executor.ts`: popula `record.strategyName = config.trading.strategyName` em `executeSimulated` e `executeLive`.
- `orchestrator.ts`: passa `strategyName` ao salvar decisão.
- `storage/trades.ts` e `storage/decisions.ts`: tipos `TradeRecord` e `DecisionRecord` ganham campo `strategyName`. Insert SQL atualizado.

### 4. Stats CLI + HTML (`src/scripts/stats.ts`)

`package.json` ganha: `"stats": "ts-node src/scripts/stats.ts"`.

**Saída terminal:**
```
PAPER STATS — ema9_21+claude_v1
  Window: 2026-05-19 → 2026-06-02 (14d)
  Trades:        12 (open: 2, closed: 10)
  Win rate:      60.0%  (buy: 66.7% [4/6]  sell: 50.0% [2/4])
  Realized PnL:  +$23.45  (+2.35%)
  Open PnL:      +$5.10   (unrealized, mark-to-market)
  Equity:        $1023.45 (start $1000.00)
  Max DD:        -1.8%
  Best trade:    +$12.40  (BTCUSDT BUY  2026-05-21)
  Worst trade:   -$8.10   (BTCUSDT SELL 2026-05-23)
  Avg holding:   8.2h
  Avg R/R:       2.3
  Daily gate:    OK (today: -0.4% / 1 loss)
```

**Argumentos opcionais:** `--strategy ema9_21+claude_v1` (filtra), `--since 2026-05-19` (override janela).

**HTML (`data/stats.html`):**

Single file, zero build, Chart.js via CDN (`https://cdn.jsdelivr.net/npm/chart.js`).

**Aplicação dos princípios de `frontend-design`:**
- **Aesthetic direction:** editorial financial / brutalist data — preto profundo, tipografia massiva, números em destaque, sem decoração genérica.
- **Tipografia:**
  - Display: `JetBrains Mono` (Google Fonts) — para números (equity, PnL), tabela.
  - Body: `Fraunces` (Google Fonts, opsz 144) — para labels, títulos secundários, parágrafos.
  - **Banido:** Inter, Roboto, Arial, system-ui.
- **Paleta (CSS vars):**
  ```css
  --bg: #0a0a0a;
  --fg: #f5f1e8;
  --dim: #6b6660;
  --pos: #7cff6b;
  --neg: #ff5b5b;
  --rule: #1c1c1c;
  ```
- **Layout:** asymmetric grid, sem cards arredondados:
  - Header full-width: equity gigante (96px, letter-spacing -0.04em) alinhado à esquerda, delta % e $ em coluna estreita à direita.
  - Stats grid 2/3 + 1/3: trades + win rates à esquerda, max DD + holding + R/R à direita.
  - Equity curve: linha única, sem fill, eixos sutis, grid lines `#1c1c1c`.
  - Tabela de trades em monospace, separadores horizontais finos (`1px solid var(--rule)`), sem zebra.
  - Footer: timestamp + DB path em monospace cinza `--dim`.
- **Motion:**
  - On load: equity number count-up (`0 → equity` em 1.2s ease-out cubic-bezier).
  - Staggered fade-in: header 0ms, stats 150ms, chart 400ms, table 600ms.
  - Sem hover micro-interactions desnecessárias na tabela.
- **Sem AI slop:** zero gradientes purple/blue, zero box-shadows decorativos, zero ícones genéricos (lucide, heroicons), zero "neumorphism".

**Conteúdo HTML:**
- Header: equity atual, delta absoluto, delta %, sinal.
- Stats secundários (grid): total trades, # open, # closed, win rate total, win rate buy/sell, max DD, avg holding, avg R/R.
- Equity curve (Chart.js line): timestamp X, equity Y, computado de `sum(realized PnL) + starting equity` em cada `closed_ts`.
- Tabela trades fechados (ordem cronológica reversa): ts | symbol | side | entry | exit | pnl % | outcome (TP_FILLED/SL_FILLED/CANCELED) | holding | strategy_name.
- Footer: gerado em `<timestamp>` · DB: `<path>`.

**Cálculo de equity curve:**
```
equity[i] = ACCOUNT_EQUITY_USD + sum(pnl_quote of closed trades where closed_ts <= t[i])
```

**Open PnL (unrealized):** preço corrente vs `avg_price`, mark-to-market. Faz 1 chamada de `getPrice` por símbolo único entre trades abertos (no MVP, só BTCUSDT — 1 chamada total).

**Avg R/R:** média de `decision.takeProfitPercent / decision.stopLossPercent` no momento de entrada, sobre trades fechados na janela. Buscado via JOIN `trades.decision_id → decisions.id`.

**Avg holding:** média de `(closed_ts - ts) / 60000` em minutos, sobre trades fechados.

### 5. Wiring no orchestrator

```typescript
// strategy/orchestrator.ts (pseudo)
async runOnce(symbol) {
  const gate = checkDailyGate();
  if (!gate.allowed) {
    log.info('Skipped: ' + gate.reason);
    return { status: 'GATED', reason: gate.reason };
  }
  // ... resto do pipeline existente (EMA, klines, Claude, validação, execute)
}
```

E no loop principal (`loop.ts`), antes/depois das decisões, chamar fill simulator pra processar fechamentos:
```typescript
await fillSimulator.runDryrunFillSim();
```

Frequência: cada tick do loop (`LOOP_INTERVAL_MINUTES=15` default). Custo Binance: 1 chamada de klines 15m por trade aberto. Trivial.

## Schema final

```sql
-- migrations adicionais
ALTER TABLE trades ADD COLUMN strategy_name TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE decisions ADD COLUMN strategy_name TEXT NOT NULL DEFAULT 'unknown';
```

Sem novas tabelas. Sem mudança em `postmortems` (já tem `notes` text livre).

## Testes

**Unit (obrigatórios):**
- `fill-simulator.spec.ts`:
  - BUY: TP hit isolado → `TP_FILLED`
  - BUY: SL hit isolado → `SL_FILLED`
  - BUY: whipsaw mesma vela → `SL_FILLED` + `notes='AMBIGUOUS_SAME_CANDLE_15M'`
  - SELL: simétrico
  - timeout: nenhum hit → `CANCELED` (outcome TIMEOUT)
- `daily-gate.spec.ts`:
  - Sem perdas → allowed
  - 1 loss 1% → allowed
  - 2 losses somando 3.5% → blocked (DD)
  - 3 losses seguidos 0.5% cada → blocked (streak)
  - Rollover UTC: ontem 3 losses, hoje vazio → allowed

**Manual:**
- Rodar `npm run dryrun` 1 hora, abrir `npm run stats`, conferir números batem com `sqlite3 data/trade.db`.

## Segurança / não-quebrar

- Migration idempotente — não falha se rodar 2x.
- `strategy_name DEFAULT 'unknown'` — trades antigos não quebram (se houver).
- Fill simulator opera só em `mode='dryrun'`. Não afeta `live` (closer.ts:runLive intocado).
- Daily gate ignora trades `live` (filtro `mode='dryrun'` na query).
- `data/stats.html` em `.gitignore`.

## Critério de "MVP pronto"

- [ ] Migration aplica sem perder dados existentes
- [ ] `npm run dryrun` roda 24h sem crash
- [ ] Unit tests passam (fill-simulator, daily-gate)
- [ ] Fill simulator fecha trades dryrun com `TP_FILLED`/`SL_FILLED` corretos
- [ ] Daily gate bloqueia após 3 SL no mesmo dia UTC (testado simulando)
- [ ] `npm run stats` imprime tabela CLI completa
- [ ] `data/stats.html` abre no browser, gráfico renderiza, fontes carregam
- [ ] 2 semanas de dryrun rodado, win-rate persistido

## Fora do escopo (próximos specs)

- Framework de signals composáveis (`Signal` interface, `Strategy = compose(signals)`).
- Multi-timeframe (30m/4h em paralelo com 1h).
- Comparação multi-estratégia (rodar 2+ estratégias em paralelo, ranquear).
- Backtest comparativo + métricas avançadas (Sharpe, Sortino).
- Dashboard live-refresh (websockets ou polling).
- Notifications em paper (Discord/Telegram já existe pra live, não estendido aqui).
- Modo `paper` distinto de `dryrun` (não justificado pelo escopo atual).

## Riscos conhecidos

1. **Ambiguidade TP/SL na mesma vela 15m.** Mitigado pela regra pessimista + flag em `notes`. Granularidade menor (1m) reduziria mas ~15x mais chamadas Binance. Aceitável pro MVP.
2. **Slippage zero assumido.** Paper assume fill exato no `tpPrice`/`slPrice`. Live terá slippage. Documentar no relatório que win-rate paper é **otimista**.
3. **Sem fees no PnL.** Binance spot taker é 0.10% por lado (~0.20% round-trip). Em $50 trade = $0.10. Mensurável mas impacto pequeno em ~$1k. **Decisão:** ignorar no MVP, documentar no spec. Adicionar depois se win-rate marginal.
4. **Janela pequena.** 2 semanas + ~10-30 trades = amostra estatística fraca. Win-rate 60% com n=10 tem CI±30%. Use como **sinal direcional**, não prova.
