import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as crypto from 'crypto';
import {
  AccountInfo,
  OcoOrderResponse,
  OrderResponse,
  SymbolFilter,
  SymbolInfo,
} from './types';

export interface SymbolFilters {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  stepSize: number;
  tickSize: number;
  minQty: number;
  minNotional: number;
  baseAssetPrecision: number;
  quoteAssetPrecision: number;
}

export class BinancePrivateClient {
  private http: AxiosInstance;
  private apiKey: string;
  private apiSecret: string;
  private recvWindow = 5_000;

  constructor(apiKey: string, apiSecret: string, baseUrl = 'https://api.binance.com') {
    if (!apiKey || !apiSecret) {
      throw new Error('BinancePrivateClient requires BINANCE_API_KEY and BINANCE_API_SECRET');
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.http = axios.create({
      baseURL: `${baseUrl}/api/v3`,
      timeout: 10_000,
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
  }

  private sign(params: Record<string, string | number>): Record<string, string | number> {
    const timestamp = Date.now();
    const payload: Record<string, string | number> = {
      ...params,
      timestamp,
      recvWindow: this.recvWindow,
    };
    const queryString = new URLSearchParams(
      Object.entries(payload).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
    return { ...payload, signature };
  }

  private async signedGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const signed = this.sign(params);
    const { data } = await this.http.get<T>(path, { params: signed });
    return data;
  }

  private async signedPost<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const signed = this.sign(params);
    const cfg: AxiosRequestConfig = { params: signed };
    const { data } = await this.http.post<T>(path, null, cfg);
    return data;
  }

  private async signedDelete<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const signed = this.sign(params);
    const { data } = await this.http.delete<T>(path, { params: signed });
    return data;
  }

  async getAccountInfo(): Promise<AccountInfo> {
    return this.signedGet<AccountInfo>('/account');
  }

  async getOpenOrders(symbol?: string): Promise<OrderResponse[]> {
    const params: Record<string, string | number> = symbol ? { symbol } : {};
    return this.signedGet<OrderResponse[]>('/openOrders', params);
  }

  async getOrderHistory(symbol: string, limit = 50): Promise<OrderResponse[]> {
    return this.signedGet<OrderResponse[]>('/allOrders', { symbol, limit });
  }

  async createMarketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quoteOrderQty: number,
  ): Promise<OrderResponse> {
    return this.signedPost<OrderResponse>('/order', {
      symbol,
      side,
      type: 'MARKET',
      quoteOrderQty,
    });
  }

  /** Market order sized in base asset (exact quantity) — used to close positions. */
  async createMarketOrderByQty(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
  ): Promise<OrderResponse> {
    return this.signedPost<OrderResponse>('/order', {
      symbol,
      side,
      type: 'MARKET',
      quantity,
    });
  }

  async createLimitOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    price: number,
  ): Promise<OrderResponse> {
    return this.signedPost<OrderResponse>('/order', {
      symbol,
      side,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity,
      price,
    });
  }

  async createStopLossLimitOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    stopPrice: number,
    limitPrice: number,
  ): Promise<OrderResponse> {
    return this.signedPost<OrderResponse>('/order', {
      symbol,
      side,
      type: 'STOP_LOSS_LIMIT',
      timeInForce: 'GTC',
      quantity,
      stopPrice,
      price: limitPrice,
    });
  }

  async createOCOOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    takeProfitPrice: number,
    stopPrice: number,
    stopLimitPrice: number,
  ): Promise<OcoOrderResponse> {
    return this.signedPost<OcoOrderResponse>('/order/oco', {
      symbol,
      side,
      quantity,
      price: takeProfitPrice,
      stopPrice,
      stopLimitPrice,
      stopLimitTimeInForce: 'GTC',
    });
  }

  async cancelOrder(symbol: string, orderId: number): Promise<OrderResponse> {
    return this.signedDelete<OrderResponse>('/order', { symbol, orderId });
  }

  async cancelOpenOrders(symbol: string): Promise<OrderResponse[]> {
    return this.signedDelete<OrderResponse[]>('/openOrders', { symbol });
  }

  async getSymbolFilters(symbol: string): Promise<SymbolFilters> {
    const { data } = await this.http.get<{ symbols: SymbolInfo[] }>('/exchangeInfo', {
      params: { symbol },
    });
    const info = data.symbols[0];
    if (!info) throw new Error(`Symbol not found: ${symbol}`);

    const findFilter = (type: string): SymbolFilter | undefined =>
      info.filters.find((f) => f.filterType === type);

    const lot = findFilter('LOT_SIZE') as { stepSize: string; minQty: string } | undefined;
    const price = findFilter('PRICE_FILTER') as { tickSize: string } | undefined;
    const notional =
      (findFilter('NOTIONAL') as { minNotional: string } | undefined) ??
      (findFilter('MIN_NOTIONAL') as { minNotional: string } | undefined);

    return {
      symbol: info.symbol,
      baseAsset: info.baseAsset,
      quoteAsset: info.quoteAsset,
      stepSize: parseFloat(lot?.stepSize ?? '0'),
      tickSize: parseFloat(price?.tickSize ?? '0'),
      minQty: parseFloat(lot?.minQty ?? '0'),
      minNotional: parseFloat(notional?.minNotional ?? '0'),
      baseAssetPrecision: info.baseAssetPrecision,
      quoteAssetPrecision: info.quoteAssetPrecision,
    };
  }

  async getBalance(asset: string): Promise<{ free: number; locked: number }> {
    const info = await this.getAccountInfo();
    const b = info.balances.find((x) => x.asset === asset);
    return {
      free: parseFloat(b?.free ?? '0'),
      locked: parseFloat(b?.locked ?? '0'),
    };
  }
}
