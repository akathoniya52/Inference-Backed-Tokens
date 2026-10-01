import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  ActivationType,
  BaseFeeMode,
  buildCurve,
  CollectFeeMode,
  CP_AMM_PROGRAM_ID,
  CpAmm,
  CreatorService,
  DAMM_V2_CONFIG_100_BPS,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DAMM_V2_PROGRAM_ID,
  DBC_POOL_AUTHORITY,
  DBC_PROGRAM_ID,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  derivePoolAddress,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  getCurrentPoint,
  MigrationFeeOption,
  MigrationOption,
  MigrationService,
  NATIVE_MINT,
  PartnerService,
  PoolService,
  StateService,
  SwapMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  USDC_MINT,
  WSOL_MINT,
} from '../src/sdk.js';

const require = createRequire(import.meta.url);

describe('Meteora SDK surface (§4)', () => {
  it('exposes the functions and classes the chain layer calls', () => {
    for (const fn of [
      buildCurve,
      deriveDbcPoolAddress,
      deriveDbcPoolAuthority,
      derivePoolAddress,
      getCurrentPoint,
      DynamicBondingCurveClient,
      CpAmm,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('has the DBC service methods the plan relies on', () => {
    expect(typeof PartnerService.prototype.createConfig).toBe('function');
    expect(typeof PartnerService.prototype.claimPartnerTradingFee).toBe('function');
    expect(typeof CreatorService.prototype.claimCreatorTradingFee).toBe('function');
    // Spec says client.pool.createPool; in 1.5.13 it is client.creator.createPool.
    expect(typeof CreatorService.prototype.createPool).toBe('function');
    expect('createPool' in PoolService.prototype).toBe(false);
    expect(typeof PoolService.prototype.swapQuote2).toBe('function');
    expect(typeof PoolService.prototype.swap2).toBe('function');
    expect(typeof MigrationService.prototype.migrateToDammV2).toBe('function');
    expect(typeof StateService.prototype.getPool).toBe('function');
    expect(typeof StateService.prototype.getPoolConfig).toBe('function');
    expect(typeof StateService.prototype.getPoolFeeMetrics).toBe('function');
  });

  it('has the cp-amm (DAMM v2) methods the plan relies on', () => {
    for (const name of [
      'claimPositionFee',
      'createPositionAndAddLiquidity',
      'addLiquidity',
      'permanentLockPosition',
      'getDepositQuote',
      'getQuote2',
      'swap2',
      'fetchPoolState',
    ] as const) {
      expect(typeof CpAmm.prototype[name]).toBe('function');
    }
  });

  it('encodes the spec drift: enum member names', () => {
    // Spec says TokenType.SPL and TokenUpdateAuthorityOption; the SDK says otherwise.
    expect(TokenType.SPLToken).toBe(0);
    expect(TokenAuthorityOption.Immutable).toBe(1);
    expect(TokenDecimal.SIX).toBe(6);
    expect(TokenDecimal.NINE).toBe(9);
    expect(BaseFeeMode.FeeSchedulerExponential).toBe(1);
    expect(MigrationOption.MET_DAMM_V2).toBe(1);
    expect(MigrationFeeOption.FixedBps100).toBe(2);
    expect(CollectFeeMode.QuoteToken).toBe(0);
    expect(ActivationType.Timestamp).toBe(1);
    expect(SwapMode.PartialFill).toBe(1);
  });

  it('DAMM_V2_MIGRATION_FEE_ADDRESS[2] is the 100 bps fee config from the spec', () => {
    const feeConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[2];
    expect(feeConfig?.toBase58()).toBe('Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp');
    expect(DAMM_V2_CONFIG_100_BPS.toBase58()).toBe('Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp');
  });

  it('program ids and PDAs match the spec addresses (Plan.md L130–135, L655–665)', () => {
    expect(DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()).toBe(DBC_PROGRAM_ID.toBase58());
    expect(DBC_PROGRAM_ID.toBase58()).toBe('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
    expect(DAMM_V2_PROGRAM_ID.toBase58()).toBe('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
    expect(CP_AMM_PROGRAM_ID.toBase58()).toBe('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
    expect(deriveDbcPoolAuthority().toBase58()).toBe(DBC_POOL_AUTHORITY.toBase58());
    expect(DBC_POOL_AUTHORITY.toBase58()).toBe('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM');
    expect(NATIVE_MINT.toBase58()).toBe(WSOL_MINT.toBase58());
    expect(WSOL_MINT.toBase58()).toBe('So11111111111111111111111111111111111111112');
    expect(USDC_MINT.devnet.toBase58()).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    expect(USDC_MINT['mainnet-beta'].toBase58()).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
  });

  it('derivePoolAddress (cp-amm) is symmetric in mint order', () => {
    const base = Keypair.generate().publicKey;
    const a = derivePoolAddress(DAMM_V2_CONFIG_100_BPS, base, NATIVE_MINT);
    const b = derivePoolAddress(DAMM_V2_CONFIG_100_BPS, NATIVE_MINT, base);
    expect(a.toBase58()).toBe(b.toBase58());
  });
});

describe('@solana/web3.js single copy (G8)', () => {
  it('SDK constants are instances of our PublicKey class', () => {
    expect(DAMM_V2_MIGRATION_FEE_ADDRESS[2]).toBeInstanceOf(PublicKey);
    expect(CP_AMM_PROGRAM_ID).toBeInstanceOf(PublicKey);
  });

  it('chain, DBC SDK and cp-amm SDK resolve the same web3.js file', () => {
    const fromHere = realpathSync(require.resolve('@solana/web3.js'));
    for (const sdk of ['@meteora-ag/dynamic-bonding-curve-sdk', '@meteora-ag/cp-amm-sdk']) {
      const sdkDir = dirname(realpathSync(require.resolve(sdk)));
      const fromSdk = realpathSync(require.resolve('@solana/web3.js', { paths: [sdkDir] }));
      expect(fromSdk).toBe(fromHere);
    }
  });
});
