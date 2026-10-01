import { describe, expect, it } from 'vitest';

import { DEFAULT_SPLITS_BPS, sliceToLamports, splitRevenue, type SplitsBps } from '../src/index.js';

/** Deterministic xorshift64* so property failures reproduce. */
function rng(seed: bigint): () => bigint {
  let state = seed;
  const mask = (1n << 64n) - 1n;
  return () => {
    state ^= state >> 12n;
    state ^= (state << 25n) & mask;
    state ^= state >> 27n;
    return (state * 0x2545f4914f6cdd1dn) & mask;
  };
}

function randomSplits(next: () => bigint): SplitsBps {
  const a = Number(next() % 10_001n);
  const b = Number(next() % BigInt(10_001 - a));
  return { providerBps: a, liquidityBps: b, platformBps: 10_000 - a - b };
}

describe('splitRevenue', () => {
  it('splits 70/20/10 exactly when divisible', () => {
    expect(splitRevenue(10_000_000n, DEFAULT_SPLITS_BPS, 'curve')).toEqual({
      providerMicro: 7_000_000n,
      liquidityMicro: 2_000_000n,
      platformMicro: 1_000_000n,
    });
  });

  it('gives the rounding remainder to the platform', () => {
    // 7·0.7 = 4.9 → 4, 7·0.2 = 1.4 → 1, platform 7 − 5 = 2 (not 0.7)
    expect(splitRevenue(7n, DEFAULT_SPLITS_BPS, 'graduated')).toEqual({
      providerMicro: 4n,
      liquidityMicro: 1n,
      platformMicro: 2n,
    });
    expect(splitRevenue(1n, DEFAULT_SPLITS_BPS, 'curve')).toEqual({
      providerMicro: 0n,
      liquidityMicro: 0n,
      platformMicro: 1n,
    });
  });

  it('folds liquidity into the provider when no token exists (G17)', () => {
    expect(splitRevenue(10_000_000n, DEFAULT_SPLITS_BPS, 'none')).toEqual({
      providerMicro: 9_000_000n,
      liquidityMicro: 0n,
      platformMicro: 1_000_000n,
    });
    expect(splitRevenue(7n, DEFAULT_SPLITS_BPS, 'none')).toEqual({
      providerMicro: 6n,
      liquidityMicro: 0n,
      platformMicro: 1n,
    });
  });

  it('handles zero revenue', () => {
    expect(splitRevenue(0n, DEFAULT_SPLITS_BPS, 'curve')).toEqual({
      providerMicro: 0n,
      liquidityMicro: 0n,
      platformMicro: 0n,
    });
  });

  it('rejects invalid input', () => {
    expect(() => splitRevenue(-1n, DEFAULT_SPLITS_BPS, 'curve')).toThrow(RangeError);
    expect(() =>
      splitRevenue(1n, { providerBps: 7000, liquidityBps: 2000, platformBps: 999 }, 'curve'),
    ).toThrow(RangeError);
    expect(() =>
      splitRevenue(1n, { providerBps: 7000.5, liquidityBps: 2000, platformBps: 999.5 }, 'curve'),
    ).toThrow(RangeError);
    expect(() =>
      splitRevenue(1n, { providerBps: -1, liquidityBps: 10_001, platformBps: 0 }, 'curve'),
    ).toThrow(RangeError);
  });

  it('property: p + l + f === rev and the platform takes the remainder (10k cases)', () => {
    const next = rng(0x1b5_7e57n);
    const phases = ['none', 'curve', 'graduated'] as const;
    const DENOM = 10_000n;
    for (let i = 0; i < 10_000; i++) {
      // Mix small values (rounding-heavy) with values far above 2^53.
      const rev = i % 2 === 0 ? next() % 1000n : next() * next();
      const splits = i % 3 === 0 ? DEFAULT_SPLITS_BPS : randomSplits(next);
      const phase = phases[i % 3] ?? 'curve';
      const {
        providerMicro: p,
        liquidityMicro: l,
        platformMicro: f,
      } = splitRevenue(rev, splits, phase);

      expect(p + l + f).toBe(rev);
      expect(p >= 0n && l >= 0n && f >= 0n).toBe(true);

      const providerBps = BigInt(
        phase === 'none' ? splits.providerBps + splits.liquidityBps : splits.providerBps,
      );
      const liquidityBps = BigInt(phase === 'none' ? 0 : splits.liquidityBps);
      expect(p).toBe((rev * providerBps) / DENOM);
      expect(l).toBe((rev * liquidityBps) / DENOM);
      // Platform gets its exact share plus < 1 micro of remainder per floored share.
      const exactPlatformScaled = rev * BigInt(splits.platformBps);
      const flooredShares = phase === 'none' ? 1n : 2n;
      expect(f * DENOM >= exactPlatformScaled).toBe(true);
      expect(f * DENOM < exactPlatformScaled + flooredShares * DENOM).toBe(true);
    }
  });
});

describe('sliceToLamports', () => {
  it('converts micro-USDC to lamports at a micro-USDC/SOL price, floored', () => {
    // $2.00 at $150/SOL = 0.013333333… SOL → 13,333,333 lamports
    expect(sliceToLamports(2_000_000n, 150_000_000n)).toBe(13_333_333n);
    expect(sliceToLamports(150_000_000n, 150_000_000n)).toBe(1_000_000_000n);
    expect(sliceToLamports(0n, 150_000_000n)).toBe(0n);
  });

  it('floors dust to 0 lamports', () => {
    // 1 micro at $1,000,000,000/SOL → 0.001 lamports
    expect(sliceToLamports(1n, 1_000_000_000_000_000n)).toBe(0n);
  });

  it('rejects a non-positive price or negative slice', () => {
    expect(() => sliceToLamports(1n, 0n)).toThrow(RangeError);
    expect(() => sliceToLamports(-1n, 1n)).toThrow(RangeError);
  });
});
