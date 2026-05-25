import { BinancePublicClient } from '../binance/public-client';

export interface PriceSource {
  getPrice(symbol: string): Promise<{ symbol: string; price: string }>;
}

const DEFAULT_TTL_MS = 15_000;

export class PriceCache {
  private cache = new Map<string, number>();
  private fetchedAt = 0;

  constructor(
    private pub: PriceSource = new BinancePublicClient(),
    private ttlMs: number = DEFAULT_TTL_MS,
    private now: () => number = () => Date.now(),
  ) {}

  async getPrices(symbols: string[]): Promise<Record<string, number>> {
    if (symbols.length === 0) return {};

    const fresh = this.now() - this.fetchedAt < this.ttlMs;
    const hasAll = symbols.every((s) => this.cache.has(s));

    if (!fresh || !hasAll) {
      for (const sym of symbols) {
        try {
          const t = await this.pub.getPrice(sym);
          this.cache.set(sym, parseFloat(t.price));
        } catch {
          // keep any prior cached value; otherwise this symbol is simply omitted
        }
      }
      this.fetchedAt = this.now();
    }

    const out: Record<string, number> = {};
    for (const s of symbols) {
      const v = this.cache.get(s);
      if (v != null) out[s] = v;
    }
    return out;
  }
}
