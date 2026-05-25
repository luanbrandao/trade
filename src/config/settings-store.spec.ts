import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readSettings,
  writeSettings,
  settingsToEnv,
  SettingsValidationError,
} from './settings-store';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-store-'));
  process.env.SETTINGS_PATH = path.join(dir, 'settings.json');
});
afterEach(() => {
  delete process.env.SETTINGS_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('settings-store', () => {
  it('returns {} when the file is absent', () => {
    expect(readSettings()).toEqual({});
  });

  it('round-trips a valid write', () => {
    const saved = writeSettings({ llmProvider: 'deepseek', llmModel: 'deepseek-chat', klineInterval: '4h' });
    expect(saved.klineInterval).toBe('4h');
    expect(readSettings().llmProvider).toBe('deepseek');
  });

  it('merges partial writes over existing', () => {
    writeSettings({ klineInterval: '1h', loopIntervalMinutes: 15 });
    writeSettings({ loopIntervalMinutes: 30 });
    const s = readSettings();
    expect(s.klineInterval).toBe('1h');
    expect(s.loopIntervalMinutes).toBe(30);
  });

  it('strips unknown and secret keys', () => {
    const saved = writeSettings({ klineInterval: '1h', ANTHROPIC_API_KEY: 'x', mode: 'live' } as any);
    expect((saved as any).ANTHROPIC_API_KEY).toBeUndefined();
    expect((saved as any).mode).toBeUndefined();
  });

  it('throws SettingsValidationError on invalid values', () => {
    expect(() => writeSettings({ amountUsd: 99999 })).toThrow(SettingsValidationError);
    expect(() => writeSettings({ klineInterval: '7m' as any })).toThrow(SettingsValidationError);
  });

  it('maps settings to provider-specific env vars', () => {
    const env = settingsToEnv({ llmProvider: 'anthropic', llmModel: 'claude-opus-4-7', loopIntervalMinutes: 30, symbols: 'BTCUSDT' });
    expect(env.LLM_PROVIDER).toBe('anthropic');
    expect(env.CLAUDE_MODEL).toBe('claude-opus-4-7');
    expect(env.LOOP_INTERVAL_MINUTES).toBe('30');
    expect(env.SYMBOLS).toBe('BTCUSDT');
    expect(env.DEEPSEEK_MODEL).toBeUndefined();
  });
});
