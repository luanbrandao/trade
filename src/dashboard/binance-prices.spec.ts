import { describe, it, expect } from 'vitest';
import { PriceCache } from './binance-prices';

class FakePub {
  calls = 0;
  prices: Record<string, string>;
  constructor(prices: Record<string, string>) {
    this.prices = prices;
  }
  async getPrice(symbol: string): Promise<{ symbol: string; price: string }> {
    this.calls += 1;
    return { symbol, price: this.prices[symbol] ?? '0' };
  }
}

describe('PriceCache', () => {
  it('fetches prices and parses to number', async () => {
    const pub = new FakePub({ BTCUSDT: '67500.5' });
    const cache = new PriceCache(pub, 15_000, () => 1000);
    const out = await cache.getPrices(['BTCUSDT']);
    expect(out.BTCUSDT).toBe(67500.5);
    expect(pub.calls).toBe(1);
  });

  it('serves from cache within TTL (no refetch)', async () => {
    const pub = new FakePub({ BTCUSDT: '100' });
    let now = 1000;
    const cache = new PriceCache(pub, 15_000, () => now);
    await cache.getPrices(['BTCUSDT']);
    now = 1000 + 14_000;
    await cache.getPrices(['BTCUSDT']);
    expect(pub.calls).toBe(1);
  });

  it('refetches after TTL expires', async () => {
    const pub = new FakePub({ BTCUSDT: '100' });
    let now = 1000;
    const cache = new PriceCache(pub, 15_000, () => now);
    await cache.getPrices(['BTCUSDT']);
    now = 1000 + 16_000;
    await cache.getPrices(['BTCUSDT']);
    expect(pub.calls).toBe(2);
  });

  it('fetches a newly requested symbol even within TTL', async () => {
    const pub = new FakePub({ BTCUSDT: '100', ETHUSDT: '3000' });
    const cache = new PriceCache(pub, 15_000, () => 1000);
    await cache.getPrices(['BTCUSDT']);
    const out = await cache.getPrices(['BTCUSDT', 'ETHUSDT']);
    expect(out.ETHUSDT).toBe(3000);
  });

  it('returns empty object for empty input without fetching', async () => {
    const pub = new FakePub({});
    const cache = new PriceCache(pub, 15_000, () => 1000);
    const out = await cache.getPrices([]);
    expect(out).toEqual({});
    expect(pub.calls).toBe(0);
  });

  it('keeps prior cached value if a fetch throws', async () => {
    const pub = new FakePub({ BTCUSDT: '100' });
    let now = 1000;
    const cache = new PriceCache(pub, 15_000, () => now);
    await cache.getPrices(['BTCUSDT']);
    pub.getPrice = async () => {
      throw new Error('network');
    };
    now = 1000 + 16_000;
    const out = await cache.getPrices(['BTCUSDT']);
    expect(out.BTCUSDT).toBe(100);
  });
});
