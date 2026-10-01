import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import {
  CLUSTERS,
  CLUSTER_CONFIG,
  DAILY_CAP_DEFAULT_MICRO,
  DAMM_V2_FEE_CONFIG,
  DAMM_V2_PROGRAM_ID,
  DBC_POOL_AUTHORITY,
  DBC_PROGRAM_ID,
  DEFAULT_MAX_TOKENS,
  DEFAULT_SPLITS_BPS,
  BPS_DENOMINATOR,
  HOLDER_DISCOUNT_BPS,
  HOLDER_MIN_BASE_UNITS,
  MAX_TOKENS_CAP,
  METEORA_MIGRATION_KEEPERS,
  MIGRATION_THRESHOLD_SOL,
  MIN_PAYOUT_MICRO,
  USDC_MINT,
  WSOL_MINT,
} from '../src/index.js';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function expectPublicKey(address: string): void {
  expect(address).toMatch(BASE58);
  expect(bs58.decode(address)).toHaveLength(32);
}

describe('constants', () => {
  it('default splits sum to 10000 bps', () => {
    const { providerBps, liquidityBps, platformBps } = DEFAULT_SPLITS_BPS;
    expect(providerBps + liquidityBps + platformBps).toBe(BPS_DENOMINATOR);
    expect(DEFAULT_SPLITS_BPS).toEqual({
      providerBps: 7000,
      liquidityBps: 2000,
      platformBps: 1000,
    });
  });

  it('program ids and addresses are valid base58 public keys', () => {
    const addresses = [
      DBC_PROGRAM_ID,
      DBC_POOL_AUTHORITY,
      DAMM_V2_PROGRAM_ID,
      DAMM_V2_FEE_CONFIG,
      WSOL_MINT,
      ...METEORA_MIGRATION_KEEPERS,
      ...CLUSTERS.map((cluster) => USDC_MINT[cluster]),
    ];
    expect(addresses).toHaveLength(9);
    for (const address of addresses) expectPublicKey(address);
  });

  it('matches the spec addresses', () => {
    expect(DBC_PROGRAM_ID).toBe('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
    expect(DAMM_V2_PROGRAM_ID).toBe('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
    expect(DAMM_V2_FEE_CONFIG).toBe('Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp');
    expect(USDC_MINT.devnet).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    expect(USDC_MINT['mainnet-beta']).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('cluster config carries the per-cluster mint and migration threshold', () => {
    expect(MIGRATION_THRESHOLD_SOL).toEqual({ devnet: 1, 'mainnet-beta': 10 });
    for (const cluster of CLUSTERS) {
      expect(CLUSTER_CONFIG[cluster]).toEqual({
        cluster,
        usdcMint: USDC_MINT[cluster],
        migrationThresholdSol: MIGRATION_THRESHOLD_SOL[cluster],
      });
    }
  });

  it('holder threshold is 1,000,000 whole tokens at 6 decimals', () => {
    expect(HOLDER_MIN_BASE_UNITS).toBe(1_000_000_000_000n);
    expect(HOLDER_DISCOUNT_BPS).toBe(1000);
  });

  it('limits and money constants', () => {
    expect(DEFAULT_MAX_TOKENS).toBeLessThanOrEqual(MAX_TOKENS_CAP);
    expect(MAX_TOKENS_CAP).toBe(8192);
    expect(MIN_PAYOUT_MICRO).toBe(1_000_000n);
    expect(DAILY_CAP_DEFAULT_MICRO).toBe(50_000_000n);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_SPLITS_BPS)).toBe(true);
    expect(Object.isFrozen(CLUSTER_CONFIG.devnet)).toBe(true);
    expect(Object.isFrozen(USDC_MINT)).toBe(true);
  });
});
