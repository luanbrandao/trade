import axios, { AxiosInstance } from 'axios';
import {
  ExchangeInfo,
  Kline,
  KlineRaw,
  OrderBook,
  PriceTicker,
  Ticker24hr,
  parseKline,
} from './types';

export type KlineInterval =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '6h' | '8h' | '12h'
  | '1d' | '3d' | '1w' | '1M';

export class BinancePublicClient {
  private http: AxiosInstance;

  constructor(baseUrl = 'https://api.binance.com') {
    this.http = axios.create({
      baseURL: `${baseUrl}/api/v3`,
      timeout: 10_000,
    });
  }

  async getPrice(symbol: string): Promise<PriceTicker> {
    const { data } = await this.http.get<PriceTicker>('/ticker/price', {
      params: { symbol },
    });
    return data;
  }

  async getAllPrices(): Promise<PriceTicker[]> {
    const { data } = await this.http.get<PriceTicker[]>('/ticker/price');
    return data;
  }

  async get24hrStats(symbol: string): Promise<Ticker24hr> {
    const { data } = await this.http.get<Ticker24hr>('/ticker/24hr', {
      params: { symbol },
    });
    return data;
  }

  async getOrderBook(symbol: string, limit = 100): Promise<OrderBook> {
    const { data } = await this.http.get<OrderBook>('/depth', {
      params: { symbol, limit },
    });
    return data;
  }

  async getKlines(
    symbol: string,
    interval: KlineInterval,
    limit = 500,
    startTime?: number,
    endTime?: number,
  ): Promise<Kline[]> {
    const params: Record<string, unknown> = { symbol, interval, limit };
    if (startTime !== undefined) params.startTime = startTime;
    if (endTime !== undefined) params.endTime = endTime;
    const { data } = await this.http.get<KlineRaw[]>('/klines', { params });
    return data.map(parseKline);
  }

  async getExchangeInfo(): Promise<ExchangeInfo> {
    const { data } = await this.http.get<ExchangeInfo>('/exchangeInfo');
    return data;
  }

  async getServerTime(): Promise<number> {
    const { data } = await this.http.get<{ serverTime: number }>('/time');
    return data.serverTime;
  }
}
