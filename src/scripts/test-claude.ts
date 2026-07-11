import { BinancePublicClient } from '../binance/public-client';
import { ClaudeClient } from '../llm/claude-client';
import { PromptContext } from '../llm/prompt';
import { fetchSnapshot } from '../strategy/market-data';
import { config } from '../config/config';

async function main() {
  const symbol = 'BTCUSDT';
  const pub = new BinancePublicClient();

  console.log(`Fetching market data for ${symbol}...`);
  const snapshot = await fetchSnapshot(pub, symbol);
  const ema = snapshot.ema;

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
