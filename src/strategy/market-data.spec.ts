import { describe, it, expect } from 'vitest';
import { DEFAULT_FETCH } from './market-data';
import { config } from '../config/config';

describe('market-data DEFAULT_FETCH', () => {
  it('sources klineInterval from config (not a hardcoded literal)', () => {
    expect(DEFAULT_FETCH.klineInterval).toBe(config.trading.klineInterval);
  });
});
