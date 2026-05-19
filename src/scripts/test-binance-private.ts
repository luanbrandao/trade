import { config } from '../config/config';
import { BinancePrivateClient } from '../binance/private-client';

async function main() {
  const client = new BinancePrivateClient(
    config.binance.apiKey,
    config.binance.apiSecret,
  );

  console.log('Reading account info...');
  const info = await client.getAccountInfo();
  console.log(`Permissions: ${info.permissions.join(', ')}`);
  console.log(`Maker commission: ${info.makerCommission} | Taker: ${info.takerCommission}`);

  const nonZero = info.balances
    .filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
    .sort((a, b) => parseFloat(b.free) - parseFloat(a.free));

  console.log('Non-zero balances:');
  for (const b of nonZero) {
    console.log(`  ${b.asset}: free=${b.free} locked=${b.locked}`);
  }

  console.log('Open orders:');
  const open = await client.getOpenOrders();
  if (open.length === 0) console.log('  (none)');
  for (const o of open) {
    console.log(`  ${o.symbol} ${o.side} ${o.type} qty=${o.origQty} price=${o.price} status=${o.status}`);
  }

  console.log('Symbol filters BTCUSDT:');
  const filters = await client.getSymbolFilters('BTCUSDT');
  console.log(`  stepSize=${filters.stepSize} tickSize=${filters.tickSize} minQty=${filters.minQty} minNotional=${filters.minNotional}`);

  console.log('OK');
}

main().catch((err) => {
  console.error('FAIL:', err.response?.data ?? err.message);
  process.exit(1);
});
