import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from './config';

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

describe('loadConfig settings overlay', () => {
  it('defaults klineInterval to 1h when nothing is set', () => {
    delete process.env.KLINE_INTERVAL;
    // point at a guaranteed-absent file so a real ./data/settings.json can't leak in
    process.env.SETTINGS_PATH = path.join(os.tmpdir(), `cfg-absent-${Date.now()}.json`);
    expect(loadConfig().trading.klineInterval).toBe('1h');
  });

  it('lets settings.json override env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-overlay-'));
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ klineInterval: '4h', loopIntervalMinutes: 30 }),
    );
    process.env.SETTINGS_PATH = path.join(dir, 'settings.json');
    process.env.KLINE_INTERVAL = '1h'; // settings must win
    const cfg = loadConfig();
    expect(cfg.trading.klineInterval).toBe('4h');
    expect(cfg.trading.loopIntervalMinutes).toBe(30);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
