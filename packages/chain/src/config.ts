import type { Connection, PublicKey, Transaction } from '@solana/web3.js';

import {
  ActivationType,
  BaseFeeMode,
  buildCurve,
  type BuildCurveParams,
  type Cluster,
  CollectFeeMode,
  type ConfigParameters,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  NATIVE_MINT,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
} from './sdk.js';

/** Graduation threshold in SOL (Plan.md L80, launch class A5). */
export const MIGRATION_QUOTE_THRESHOLD_SOL: Readonly<Record<Cluster, number>> = {
  devnet: 1,
  'mainnet-beta': 10,
};

/**
 * The `buildCurve` input from Plan.md L97–113 with the §4 SDK drift applied:
 * `TokenType.SPLToken` (spec: `SPL`) and `tokenAuthorityOption` (spec:
 * `tokenUpdateAuthority: TokenUpdateAuthorityOption.Immutable`).
 */
export function partnerCurveInput(cluster: Cluster): BuildCurveParams {
  return {
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: 3000,
          endingFeeBps: 100,
          numberOfPeriod: 60,
          totalDuration: 3600,
        },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 50,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: MIGRATION_QUOTE_THRESHOLD_SOL[cluster],
  };
}

export function buildPartnerConfigParams(cluster: Cluster): ConfigParameters {
  return buildCurve(partnerCurveInput(cluster));
}

export interface CreateConfigTxInput {
  connection: Connection;
  configPubkey: PublicKey;
  treasury: PublicKey;
  cluster: Cluster;
}

/**
 * Unsigned `createConfig` transaction (no RPC call; blockhash and fee payer are
 * set by the sender). Signers: `configPubkey`'s keypair and the treasury, which
 * is payer, fee claimer and leftover receiver.
 */
export function buildCreateConfigTx({
  connection,
  configPubkey,
  treasury,
  cluster,
}: CreateConfigTxInput): Promise<Transaction> {
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  return client.partner.createConfig({
    config: configPubkey,
    feeClaimer: treasury,
    leftoverReceiver: treasury,
    payer: treasury,
    quoteMint: NATIVE_MINT,
    ...buildPartnerConfigParams(cluster),
  });
}
