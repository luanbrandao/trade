import { BinancePublicClient } from '../binance/public-client';

async function main() {
  const client = new BinancePublicClient();

  console.log('Server time:', await client.getServerTime());

  const ticker = await client.get24hrStats('BTCUSDT');
  console.log(`BTCUSDT 24h: last=${ticker.lastPrice} change=${ticker.priceChangePercent}%`);

  const klines = await client.getKlines('BTCUSDT', '1h', 5);
  console.log(`Klines (1h, last 5):`);
  for (const k of klines) {
    const ts = new Date(k.openTime).toISOString();
    console.log(`  ${ts}  O=${k.open}  H=${k.high}  L=${k.low}  C=${k.close}  V=${k.volume}`);
  }

  const book = await client.getOrderBook('BTCUSDT', 5);
  console.log(`Order book top 5: bid=${book.bids[0]?.[0]} ask=${book.asks[0]?.[0]}`);

  console.log('OK');
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
