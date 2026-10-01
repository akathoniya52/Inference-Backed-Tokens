import { describe, expect, it } from 'vitest';

import {
  formatCount,
  formatDecimal,
  formatPct,
  formatPeriod,
  formatSol,
  formatUnits,
  formatUsdc,
  shortAddress,
} from './format';

describe('formatUnits', () => {
  it('formats zero without a fraction', () => {
    expect(formatUnits(0n, 6)).toBe('0');
    expect(formatUnits('0', 9, 2)).toBe('0');
    expect(formatUnits(0n, 0)).toBe('0');
  });

  it('trims trailing fractional zeros and the dot', () => {
    expect(formatUnits(1_500_000n, 6)).toBe('1.5');
    expect(formatUnits(2_000_000n, 6)).toBe('2');
    expect(formatUnits(1_230_000n, 6, 4)).toBe('1.23');
  });

  it('keeps leading fractional zeros', () => {
    expect(formatUnits(1n, 6)).toBe('0.000001');
    expect(formatUnits(400n, 6)).toBe('0.0004');
  });

  it('rounds half away from zero at maxFractionDigits', () => {
    expect(formatUnits(1_234_499n, 6, 2)).toBe('1.23');
    expect(formatUnits(1_235_000n, 6, 2)).toBe('1.24');
    expect(formatUnits(999_999_999n, 9, 4)).toBe('1');
    expect(formatUnits(-1_235_000n, 6, 2)).toBe('-1.24');
    expect(formatUnits(4n, 6, 5)).toBe('0');
    expect(formatUnits(-4n, 6, 5)).toBe('0');
    expect(formatUnits(1_999_500n, 6, 0)).toBe('2');
  });

  it('ignores maxFractionDigits above decimals', () => {
    expect(formatUnits(1_500n, 3, 9)).toBe('1.5');
  });

  it('handles values far beyond Number.MAX_SAFE_INTEGER exactly', () => {
    expect(formatUnits('123456789012345678901234567890', 9)).toBe(
      '123,456,789,012,345,678,901.23456789',
    );
    expect(formatUnits(1_000_000_000n * 10n ** 9n, 9)).toBe('1,000,000,000');
    expect(formatUnits(9_007_199_254_740_993n, 0)).toBe('9,007,199,254,740,993');
  });

  it('groups the whole part of negative values', () => {
    expect(formatUnits(-1_234_567_000_000n, 6)).toBe('-1,234,567');
  });

  it('rejects non-integer strings and bad digit counts', () => {
    expect(() => formatUnits('1.5', 6)).toThrow(RangeError);
    expect(() => formatUnits('abc', 6)).toThrow(RangeError);
    expect(() => formatUnits(1n, -1)).toThrow(RangeError);
    expect(() => formatUnits(1n, 6, 1.5)).toThrow(RangeError);
  });
});

describe('formatUsdc', () => {
  it('formats micro-USDC with up to 6 fraction digits', () => {
    expect(formatUsdc(12_500_000n)).toBe('12.5');
    expect(formatUsdc('1')).toBe('0.000001');
    expect(formatUsdc(0n)).toBe('0');
  });

  it('accepts a narrower precision', () => {
    expect(formatUsdc(12_345_678n, 2)).toBe('12.35');
  });
});

describe('formatSol', () => {
  it('formats lamports to 4 fraction digits by default', () => {
    expect(formatSol(1_000_000_000n)).toBe('1');
    expect(formatSol(1_234_567_890n)).toBe('1.2346');
    expect(formatSol('10000000000')).toBe('10');
  });

  it('accepts a wider precision', () => {
    expect(formatSol(1n, 9)).toBe('0.000000001');
  });
});

describe('shortAddress', () => {
  it('keeps the first and last four characters', () => {
    expect(shortAddress('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')).toBe('4zMM…ncDU');
  });

  it('returns short strings unchanged', () => {
    expect(shortAddress('abc')).toBe('abc');
    expect(shortAddress('abcdefghi')).toBe('abcdefghi');
  });

  it('accepts a custom length', () => {
    expect(shortAddress('So11111111111111111111111111111111111111112', 6)).toBe('So1111…111112');
  });
});

describe('formatPct', () => {
  it('formats a ratio as a percentage with trimmed zeros', () => {
    expect(formatPct(0.9876)).toBe('98.8%');
    expect(formatPct(1)).toBe('100%');
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(0.12344, 2)).toBe('12.34%');
  });

  it('renders non-finite input as a dash', () => {
    expect(formatPct(Number.NaN)).toBe('—');
    expect(formatPct(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatDecimal', () => {
  it('rounds API decimal strings to maxFractionDigits and groups the whole part', () => {
    expect(formatDecimal('312.448120', 2)).toBe('312.45');
    expect(formatDecimal('1234567.5', 2)).toBe('1,234,567.5');
    expect(formatDecimal('0.0000000061', 4)).toBe('0');
    expect(formatDecimal('-0.004', 2)).toBe('0');
  });

  it('pads to minFractionDigits', () => {
    expect(formatDecimal('14.3', 6, 2)).toBe('14.30');
    expect(formatDecimal('0.200000', 6, 2)).toBe('0.20');
    expect(formatDecimal('3', 4, 2)).toBe('3.00');
    expect(formatDecimal('0.000123', 6, 2)).toBe('0.000123');
  });

  it('rejects non-decimal input', () => {
    expect(() => formatDecimal('1e3', 2)).toThrow(RangeError);
    expect(() => formatDecimal('1', 1, 2)).toThrow(RangeError);
  });
});

describe('formatCount', () => {
  it('groups integers', () => {
    expect(formatCount(48211)).toBe('48,211');
    expect(formatCount(0)).toBe('0');
  });
});

describe('formatPeriod', () => {
  it('formats an hourly UTC window', () => {
    expect(formatPeriod('2026-10-02T13:00:00.000Z', '2026-10-02T14:00:00.000Z')).toBe(
      '2 Oct 2026, 13:00–14:00 UTC',
    );
  });

  it('spells out both dates when the window crosses midnight', () => {
    expect(formatPeriod('2026-10-02T23:00:00.000Z', '2026-10-03T00:00:00.000Z')).toBe(
      '2 Oct 2026, 23:00 – 3 Oct 2026, 00:00 UTC',
    );
  });
});
