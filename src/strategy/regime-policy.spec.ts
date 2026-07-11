import { describe, it, expect } from 'vitest';
import { effectiveMinConfidence, maxPositionsForRegime } from './regime-policy';

describe('effectiveMinConfidence', () => {
  it('raises the floor by 10 in CHOPPY', () => {
    expect(effectiveMinConfidence(70, 'CHOPPY')).toBe(80);
  });

  it('raises the floor by 5 in UNKNOWN', () => {
    expect(effectiveMinConfidence(70, 'UNKNOWN')).toBe(75);
  });

  it('keeps the base in RISK_ON / RISK_OFF / undefined', () => {
    expect(effectiveMinConfidence(70, 'RISK_ON')).toBe(70);
    expect(effectiveMinConfidence(70, 'RISK_OFF')).toBe(70);
    expect(effectiveMinConfidence(70, undefined)).toBe(70);
  });

  it('caps at 100', () => {
    expect(effectiveMinConfidence(95, 'CHOPPY')).toBe(100);
  });
});

describe('maxPositionsForRegime', () => {
  it('caps at 1 in RISK_OFF', () => {
    expect(maxPositionsForRegime(3, 'RISK_OFF')).toBe(1);
  });

  it('caps at 2 in CHOPPY', () => {
    expect(maxPositionsForRegime(3, 'CHOPPY')).toBe(2);
  });

  it('keeps configured max in RISK_ON or unknown regime', () => {
    expect(maxPositionsForRegime(3, 'RISK_ON')).toBe(3);
    expect(maxPositionsForRegime(3, undefined)).toBe(3);
  });

  it('never raises above the configured max', () => {
    expect(maxPositionsForRegime(1, 'CHOPPY')).toBe(1);
  });
});
