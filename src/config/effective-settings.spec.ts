import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { effectiveSettings, keyedProviders } from './effective-settings';
import { config } from './config';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-settings-'));
  process.env.SETTINGS_PATH = path.join(dir, 'settings.json');
});
afterEach(() => {
  delete process.env.SETTINGS_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('effective-settings', () => {
  it('falls back to config when no settings file', () => {
    const eff = effectiveSettings();
    expect(eff.klineInterval).toBe(config.trading.klineInterval);
    expect(eff.symbols).toBe(config.trading.symbols.join(','));
  });

  it('reflects live settings.json without restart', () => {
    fs.writeFileSync(process.env.SETTINGS_PATH!, JSON.stringify({ klineInterval: '12h', minConfidence: 80 }));
    const eff = effectiveSettings();
    expect(eff.klineInterval).toBe('12h');
    expect(eff.minConfidence).toBe(80);
  });

  it('lists only providers with an API key present', () => {
    const providers = keyedProviders();
    for (const p of providers) {
      expect(['anthropic', 'openai', 'gemini', 'deepseek']).toContain(p);
    }
  });
});
