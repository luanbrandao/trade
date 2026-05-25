export interface LoopStatus {
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  uptimeSec: number;
  lastTickAt: number | null;
  adopted: boolean;
}

export interface DailyGateSnapshot {
  allowed: boolean;
  reason: string | null;
  ddPct: number;
  streak: number;
}

export interface StatsSnapshot {
  strategyName: string;
  windowStart: number;
  windowEnd: number;
  startingEquity: number;
  equityNow: number;
  realizedPnlQuote: number;
  realizedPnlPct: number;
  openPnlQuote: number;
  winRateTotal: number;
  winRateBuy: number;
  winRateSell: number;
  winsBuy: number;
  totalBuy: number;
  winsSell: number;
  totalSell: number;
  maxDdPct: number;
  avgHoldingMinutes: number;
  avgRrRatio: number;
  tradesClosed: number;
  tradesOpen: number;
  dailyGate: DailyGateSnapshot;
}

export interface OpenTradeView {
  id: number;
  ts: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  entry: number;
  currentPrice: number;
  pnlQuote: number;
  pnlPct: number;
  strategyName: string;
}

export interface ClosedTradeView {
  id: number;
  ts: number;
  closedTs: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  entry: number;
  exit: number;
  pnlQuote: number;
  pnlPct: number;
  status: string;
  holdingHours: number;
  strategyName: string;
}

export interface DecisionView {
  ts: number;
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reason: string | null;
  executed: boolean;
  skipReason: string | null;
}

export interface LlmCost {
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  byModel: Record<string, number>;
}

export interface DashboardSnapshot {
  loop: LoopStatus;
  stats: StatsSnapshot;
  openTrades: OpenTradeView[];
  closedTrades: ClosedTradeView[];
  decisions: DecisionView[];
  equityCurve: { ts: number; equity: number }[];
  llmCost: LlmCost;
}

export interface LogLine {
  ts: number;
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface LoopEvent {
  running: boolean;
  reason: string;
}
