/**
 * The single import point for Meteora SDK symbols in the chain layer.
 * Verified against `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 and
 * `@meteora-ag/cp-amm-sdk` 1.5.1 by `test/sdk-surface.test.ts`.
 *
 * Spec drift (Plan.md L96–124 vs the installed SDKs, work plan §4):
 * - `TokenType.SPL` is `TokenType.SPLToken`.
 * - `tokenUpdateAuthority: TokenUpdateAuthorityOption.Immutable` is
 *   `tokenAuthorityOption: TokenAuthorityOption.Immutable` in the `buildCurve`
 *   token config (`buildCurve` still emits `tokenUpdateAuthority` in its output).
 * - `migrateToDammV2({ payer, virtualPool, dammConfig })` is
 *   `migrateToDammV2({ payer, pool, dammConfig })` and returns
 *   `{ transaction, firstPositionNftKeypair, secondPositionNftKeypair }`;
 *   both keypairs must co-sign the transaction.
 * - `client.pool.createPool(...)` is `client.creator.createPool(...)`
 *   (`CreatorService`); `client.pool` only swaps and quotes.
 * - Lifetime pool fees come from
 *   `client.state.getPoolFeeMetrics(pool).total.totalTradingQuoteFee`.
 * - `DAMM_V2_MIGRATION_FEE_ADDRESS` is a `PublicKey[]`; index 2 is the 100 bps
 *   config `Hv8Lmz…cjp` (`MigrationFeeOption.FixedBps100 === 2`).
 * - cp-amm builders return `Promise<Transaction>`. `derivePoolAddress` sorts
 *   the two mints itself, so argument order does not matter.
 *
 * Both SDKs are loaded through Node's ESM entry (DBC ships `dist/index.js`
 * with `"type": "module"`; cp-amm is CJS and its named exports are detected
 * by Node's CJS interop), so plain named imports work.
 *
 * SOL price source (G25/G26), confirmed from https://dev.jup.ag/docs/price/v3
 * on 2026-10-02: `JUPITER_PRICE_URL=https://api.jup.ag/price/v3`, called as
 * `GET {JUPITER_PRICE_URL}?ids=<mint>[,<mint>…]` (max 50 ids). The response is
 * `{ [mint]: { usdPrice: number, blockId: number, decimals: number,
 * priceChange24h: number } }`; mints without a reliable price are omitted
 * (no key, no error). `JUPITER_API_KEY` is optional: without it the endpoint
 * is keyless at 0.5 RPS; with it, send header `x-api-key: <key>` (Free tier
 * 1 RPS). An unknown key returns 401. The hourly keeper fits the keyless tier.
 */
import { NATIVE_MINT } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import {
  convertToLamports as sdkConvertToLamports,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  MigrationFeeOption,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

export {
  ActivationType,
  BaseFeeMode,
  buildCurve,
  CollectFeeMode,
  convertToLamports,
  CreatorService,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DAMM_V2_PROGRAM_ID,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  getCurrentPoint,
  MigrationFeeOption,
  MigrationOption,
  MigrationService,
  PartnerService,
  PoolService,
  StateService,
  SwapMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
export type {
  BuildCurveParams,
  ConfigParameters,
  CreateConfigParams,
  MigrateToDammV2Params,
  MigrateToDammV2Response,
  PoolConfig,
  Swap2Params,
  SwapQuote2Params,
  SwapQuote2Result,
  VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
export {
  CP_AMM_PROGRAM_ID,
  CpAmm,
  derivePoolAddress,
  derivePositionAddress,
  derivePositionNftAccount,
  getCurrentPoint as getDammCurrentPoint,
  getTokenProgram,
  SwapMode as DammSwapMode,
} from '@meteora-ag/cp-amm-sdk';
export type { PoolState as DammPoolState } from '@meteora-ag/cp-amm-sdk';
export { NATIVE_MINT };

// TODO(P2-T8): move the address constants below to @ibt/shared.

export type Cluster = 'devnet' | 'mainnet-beta';

export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
export const DBC_POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const USDC_MINT: Readonly<Record<Cluster, PublicKey>> = {
  devnet: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  'mainnet-beta': new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
};

const dammV2Config100Bps = DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100];
if (!dammV2Config100Bps) {
  throw new Error('DBC SDK no longer exports DAMM_V2_MIGRATION_FEE_ADDRESS[FixedBps100]');
}
/** DAMM v2 fee config for the 100 bps fixed option (`Hv8Lmz…cjp`), the `dammConfig` for migration. */
export const DAMM_V2_CONFIG_100_BPS: PublicKey = dammV2Config100Bps;

/** bn.js is not a direct dependency; the SDK's `convertToLamports(x, 0)` builds a BN from an integer. */
export type BNValue = ReturnType<typeof sdkConvertToLamports>;
export const toBN = (value: bigint): BNValue => sdkConvertToLamports(value.toString(), 0);
