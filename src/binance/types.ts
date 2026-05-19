export interface Ticker24hr {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  lastPrice: string;
  volume: string;
  quoteVolume: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  openTime: number;
  closeTime: number;
  count: number;
}

export interface PriceTicker {
  symbol: string;
  price: string;
}

export type KlineRaw = [
  number,  // open time
  string,  // open
  string,  // high
  string,  // low
  string,  // close
  string,  // volume
  number,  // close time
  string,  // quote asset volume
  number,  // number of trades
  string,  // taker buy base volume
  string,  // taker buy quote volume
  string,  // ignore
];

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  trades: number;
}

export interface OrderBook {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export interface Balance {
  asset: string;
  free: string;
  locked: string;
}

export interface AccountInfo {
  makerCommission: number;
  takerCommission: number;
  balances: Balance[];
  permissions: string[];
}

export interface OrderFill {
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
}

export interface OrderResponse {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  transactTime: number;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';
  side: 'BUY' | 'SELL';
  type: string;
  fills?: OrderFill[];
}

export interface OcoOrderResponse {
  orderListId: number;
  contingencyType: string;
  listStatusType: string;
  listOrderStatus: string;
  symbol: string;
  orders: { symbol: string; orderId: number; clientOrderId: string }[];
}

export interface SymbolFilter {
  filterType: string;
  [k: string]: unknown;
}

export interface SymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  baseAssetPrecision: number;
  quoteAssetPrecision: number;
  filters: SymbolFilter[];
}

export interface ExchangeInfo {
  timezone: string;
  serverTime: number;
  symbols: SymbolInfo[];
}

export function parseKline(raw: KlineRaw): Kline {
  return {
    openTime: raw[0],
    open: parseFloat(raw[1]),
    high: parseFloat(raw[2]),
    low: parseFloat(raw[3]),
    close: parseFloat(raw[4]),
    volume: parseFloat(raw[5]),
    closeTime: raw[6],
    trades: raw[8],
  };
}
