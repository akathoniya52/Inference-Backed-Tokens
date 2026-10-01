import { describe, expect, it } from 'vitest';

import {
  applyDiscount,
  computeCostMicro,
  estimateHoldMicro,
  holderDiscountBps,
  lamportsToSol,
  microToUsdcString,
  solToLamports,
  usdcStringToMicro,
} from '../src/index.js';

const ABOVE_2_53 = 2n ** 53n + 1n;

describe('microToUsdcString', () => {
  it('formats with exactly 6 decimals', () => {
    expect(microToUsdcString(0n)).toBe('0.000000');
    expect(microToUsdcString(1n)).toBe('0.000001');
    expect(microToUsdcString(25_000_000n)).toBe('25.000000');
    expect(microToUsdcString(31_420_000n)).toBe('31.420000');
    expect(microToUsdcString(-500_000n)).toBe('-0.500000');
  });

  it('stays exact above 2^53', () => {
    expect(microToUsdcString(ABOVE_2_53)).toBe('9007199254.740993');
  });
});

describe('usdcStringToMicro', () => {
  it('parses whole and fractional amounts', () => {
    expect(usdcStringToMicro('25')).toBe(25_000_000n);
    expect(usdcStringToMicro('25.5')).toBe(25_500_000n);
    expect(usdcStringToMicro('0.000001')).toBe(1n);
    expect(usdcStringToMicro('-1.25')).toBe(-1_250_000n);
    expect(usdcStringToMicro('9007199254.740993')).toBe(ABOVE_2_53);
  });

  it('round-trips with microToUsdcString', () => {
    for (const micro of [0n, 1n, 999_999n, 1_000_000n, -7n, ABOVE_2_53 * 1000n]) {
      expect(usdcStringToMicro(microToUsdcString(micro))).toBe(micro);
    }
  });

  it('rejects malformed input and sub-micro precision', () => {
    for (const bad of ['', '.5', '1.', '1e6', 'abc', '1.0000001', ' 1', '+1', '--1']) {
      expect(() => usdcStringToMicro(bad), bad).toThrow(RangeError);
    }
  });
});

describe('lamports', () => {
  it('formats SOL with trailing zeros trimmed', () => {
    expect(lamportsToSol(0n)).toBe('0');
    expect(lamportsToSol(1n)).toBe('0.000000001');
    expect(lamportsToSol(4_200_000_000n)).toBe('4.2');
    expect(lamportsToSol(10_000_000_000n)).toBe('10');
    expect(lamportsToSol(ABOVE_2_53)).toBe('9007199.254740993');
  });

  it('parses SOL to lamports', () => {
    expect(solToLamports('0.8')).toBe(800_000_000n);
    expect(solToLamports('2')).toBe(2_000_000_000n);
    expect(() => solToLamports('0.0000000001')).toThrow(RangeError);
  });
});

describe('computeCostMicro (G16: ceil)', () => {
  it('charges 1 micro for 1 token at 1 micro/MTok', () => {
    expect(computeCostMicro({ pt: 1n, ct: 0n, inPrice: 1n, outPrice: 1n })).toBe(1n);
    expect(computeCostMicro({ pt: 0n, ct: 1n, inPrice: 1n, outPrice: 1n })).toBe(1n);
  });

  it('charges 0 for 0 tokens', () => {
    expect(computeCostMicro({ pt: 0n, ct: 0n, inPrice: 5_000_000n, outPrice: 9n })).toBe(0n);
  });

  it('is exact at the micro boundary and rounds up above it', () => {
    expect(computeCostMicro({ pt: 1_000_000n, ct: 0n, inPrice: 1n, outPrice: 0n })).toBe(1n);
    expect(computeCostMicro({ pt: 1_000_001n, ct: 0n, inPrice: 1n, outPrice: 0n })).toBe(2n);
    expect(computeCostMicro({ pt: 999_999n, ct: 0n, inPrice: 1n, outPrice: 0n })).toBe(1n);
  });

  it('sums input and output before rounding', () => {
    // 500k × 1 + 500k × 1 = 1e6 → exactly 1 micro, not ceil(0.5) + ceil(0.5) = 2
    expect(computeCostMicro({ pt: 500_000n, ct: 500_000n, inPrice: 1n, outPrice: 1n })).toBe(1n);
    // 1,000 prompt at $0.20/MTok + 256 completion at $0.80/MTok = 200 + 204.8 → 405
    expect(computeCostMicro({ pt: 1000n, ct: 256n, inPrice: 200_000n, outPrice: 800_000n })).toBe(
      405n,
    );
  });

  it('accepts JSON-safe numbers and strings, and stays exact above 2^53', () => {
    expect(computeCostMicro({ pt: 1000, ct: '256', inPrice: 200_000, outPrice: '800000' })).toBe(
      405n,
    );
    expect(
      computeCostMicro({ pt: ABOVE_2_53.toString(), ct: 0n, inPrice: 1_000_000n, outPrice: 0n }),
    ).toBe(ABOVE_2_53);
  });

  it('rejects negative or fractional inputs', () => {
    expect(() => computeCostMicro({ pt: -1n, ct: 0n, inPrice: 1n, outPrice: 1n })).toThrow(
      RangeError,
    );
    expect(() => computeCostMicro({ pt: 1.5, ct: 0n, inPrice: 1n, outPrice: 1n })).toThrow(
      RangeError,
    );
    expect(() => computeCostMicro({ pt: '1.5', ct: 0n, inPrice: 1n, outPrice: 1n })).toThrow(
      RangeError,
    );
  });
});

describe('estimateHoldMicro', () => {
  it('uses max_tokens as completion tokens', () => {
    expect(
      estimateHoldMicro({
        promptTokens: 1000,
        maxTokens: 256,
        inPrice: 200_000n,
        outPrice: 800_000n,
      }),
    ).toBe(405n);
  });

  it('defaults max_tokens to 1024', () => {
    expect(estimateHoldMicro({ promptTokens: 0, inPrice: 0n, outPrice: 1_000_000n })).toBe(1024n);
  });
});

describe('applyDiscount (G16: floor)', () => {
  it('floors the discounted cost', () => {
    expect(applyDiscount(405n, 1000)).toBe(364n); // 364.5
    expect(applyDiscount(1n, 1000)).toBe(0n); // 0.9
    expect(applyDiscount(10n, 1000)).toBe(9n);
    expect(applyDiscount(405n, 0)).toBe(405n);
    expect(applyDiscount(405n, 10_000)).toBe(0n);
  });

  it('rejects out-of-range bps', () => {
    expect(() => applyDiscount(1n, -1)).toThrow(RangeError);
    expect(() => applyDiscount(1n, 10_001)).toThrow(RangeError);
    expect(() => applyDiscount(1n, 0.5)).toThrow(RangeError);
  });
});

describe('holderDiscountBps', () => {
  it('grants 1000 bps at or above 1,000,000 whole tokens', () => {
    expect(holderDiscountBps(999_999_999_999n)).toBe(0);
    expect(holderDiscountBps(1_000_000_000_000n)).toBe(1000);
    expect(holderDiscountBps('5000000000000')).toBe(1000);
  });
});
