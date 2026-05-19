import { BinancePublicClient } from '../binance/public-client';
import { emaState } from '../indicators/ema';
import { ClaudeClient } from '../llm/claude-client';
import { MarketSnapshot, PromptContext } from '../llm/prompt';
import { config } from '../config/config';

async function main() {
  const symbol = 'BTCUSDT';
  const pub = new BinancePublicClient();

  console.log(`Fetching market data for ${symbol}...`);
  const [ticker, klines, book] = await Promise.all([
    pub.get24hrStats(symbol),
    pub.getKlines(symbol, '1h', 100),
    pub.getOrderBook(symbol, 10),
  ]);

  const closes = klines.map((k) => k.close);
  const ema = emaState(closes, 9, 21);
  if (!ema) throw new Error('Insufficient klines for EMA');

  const snapshot: MarketSnapshot = {
    symbol,
    currentPrice: closes[closes.length - 1],
    ticker24h: ticker,
    klines1h: klines,
    ema,
    topBids: book.bids.slice(0, 5),
    topAsks: book.asks.slice(0, 5),
  };

  const ctx: PromptContext = {
    minConfidence: config.trading.minConfidence,
    minRrRatio: config.trading.minRrRatio,
    cooldownMinutes: config.trading.cooldownMinutes,
    amountUsd: config.trading.amountUsd,
    hasOpenPosition: false,
  };

  console.log(`EMA fast=${ema.fast.toFixed(2)} slow=${ema.slow.toFixed(2)} trend=${ema.trend} cross=${ema.cross}`);
  console.log(`Calling Claude (${config.anthropic.model}, effort=${config.anthropic.effort})...`);

  const claude = new ClaudeClient();
  const result = await claude.decide(snapshot, ctx);

  console.log('\n=== Decision ===');
  console.log(`Action: ${result.decision.action}`);
  console.log(`Confidence: ${result.decision.confidence}%`);
  console.log(`Stop loss: ${result.decision.stopLossPercent}%`);
  console.log(`Take profit: ${result.decision.takeProfitPercent}%`);
  console.log(`R/R: ${(result.decision.takeProfitPercent / result.decision.stopLossPercent).toFixed(2)}:1`);
  console.log(`Horizon: ${result.decision.timeHorizonMinutes} min`);
  console.log(`Reason: ${result.decision.reason}`);
  console.log(`Risks:`);
  for (const r of result.decision.keyRisks) console.log(`  - ${r}`);

  console.log('\n=== Usage ===');
  console.log(`Model: ${result.model}  Stop: ${result.stopReason}`);
  console.log(
    `Tokens: in=${result.usage.inputTokens} out=${result.usage.outputTokens} cache_read=${result.usage.cacheReadInputTokens} cache_write=${result.usage.cacheCreationInputTokens}`,
  );
  console.log(`Estimated cost: $${result.usage.costUsd.toFixed(4)}`);

  console.log('\nOK');
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
