import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { AddressInfo } from 'net';

process.env.DB_PATH = path.resolve('./data/test-server.db');
process.env.SETTINGS_PATH = path.resolve('./data/test-server-settings.json');

import { config } from '../config/config';
import { getDb, closeDb } from '../storage/db';
import { insertTrade, TradeRecord } from '../storage/trades';
import { createServer } from './server';
import { LoopController } from './loop-controller';
import { StatsReader } from './stats-reader';
import { PriceCache } from './binance-prices';

let server: http.Server;
let base: string;
let pidFile: string;

class FakePub {
  async getPrice(symbol: string) {
    return { symbol, price: '0' };
  }
}

function seed() {
  const db = getDb();
  db.exec('DELETE FROM trades');
  db.exec('DELETE FROM decisions');
  const t: TradeRecord = {
    decisionId: null, ts: 1_000_000, symbol: 'BTCUSDT', side: 'BUY', qty: 0.001,
    avgPrice: 60000, quoteQty: 60, binanceOrderId: 'SIM-1', ocoOrderListId: null,
    tpPrice: 61200, slPrice: 59400, status: 'TP_FILLED', closedTs: 2_000_000,
    closedPrice: 61200, pnlQuote: 1.2, pnlPct: 2.0, mode: 'dryrun',
    strategyName: config.trading.strategyName,
  };
  insertTrade(t);
}

beforeAll(async () => {
  seed();
  pidFile = path.join(os.tmpdir(), `server-test-${process.pid}.pid`);
  const controller = new LoopController({ command: '/bin/sleep', args: ['30'], pidFile });
  const reader = new StatsReader(new PriceCache(new FakePub(), 15_000, () => 0));
  server = createServer(controller, reader);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch {}
  try { if (fs.existsSync(process.env.SETTINGS_PATH!)) fs.unlinkSync(process.env.SETTINGS_PATH!); } catch {}
});

describe('dashboard server', () => {
  it('GET /api/status returns a snapshot', async () => {
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.stats.tradesClosed).toBe(1);
    expect(body.loop.running).toBe(false);
    expect(Array.isArray(body.closedTrades)).toBe(true);
    expect(body.llm.provider).toBeDefined();
    expect(body.llm.model).toBeDefined();
  });

  it('GET / serves the HTML shell', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('TRADE');
  });

  it('POST /api/start then /api/stop flips running state', async () => {
    const start = await fetch(`${base}/api/start`, { method: 'POST' });
    expect(start.status).toBe(200);
    expect(((await start.json()) as any).ok).toBe(true);

    const running = (await (await fetch(`${base}/api/status`)).json()) as any;
    expect(running.loop.running).toBe(true);

    const dup = await fetch(`${base}/api/start`, { method: 'POST' });
    expect(dup.status).toBe(409);

    const stop = await fetch(`${base}/api/stop`, { method: 'POST' });
    expect(stop.status).toBe(200);

    const stopped = (await (await fetch(`${base}/api/status`)).json()) as any;
    expect(stopped.loop.running).toBe(false);
  });

  it('GET /api/stream opens an SSE channel', async () => {
    const res = await fetch(`${base}/api/stream`, { headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk.length).toBeGreaterThan(0); // keepalive ':' or an event frame
    await reader.cancel();
  });

  it('GET /api/logs returns an array', async () => {
    const res = await fetch(`${base}/api/logs?n=10`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it('GET /api/settings returns values and provider meta', async () => {
    const res = await fetch(`${base}/api/settings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.values.klineInterval).toBeDefined();
    expect(Array.isArray(body.meta.providers)).toBe(true);
    expect(body.meta.klineIntervals).toContain('4h');
  });

  it('POST /api/settings persists valid settings', async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ klineInterval: '4h', minConfidence: 80 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.restarted).toBe(false); // loop not running in this test
    const after = (await (await fetch(`${base}/api/settings`)).json()) as any;
    expect(after.values.klineInterval).toBe('4h');
    expect(after.values.minConfidence).toBe(80);
  });

  it('POST /api/settings rejects invalid values with 400', async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountUsd: 999 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.errors.amountUsd).toBeDefined();
  });
});
