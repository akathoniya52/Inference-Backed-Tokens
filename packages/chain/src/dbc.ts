import { AppError } from '@ibt/shared';
import type { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';

import {
  convertToLamports,
  DAMM_V2_CONFIG_100_BPS,
  deriveDbcPoolAddress,
  DynamicBondingCurveClient,
  getCurrentPoint,
  NATIVE_MINT,
  SwapMode,
} from './sdk.js';

interface Integer {
  toString(): string;
}

/** The fields of the SDK's `VirtualPool` (1.5.13 nests them under `poolState`) that we read. */
export interface VirtualPoolFields {
  poolState: {
    config: PublicKey;
    creator: PublicKey;
    baseMint: PublicKey;
    quoteReserve: Integer;
    baseReserve: Integer;
    isMigrated: number;
  };
}

export interface PoolConfigFields {
  migrationQuoteThreshold: Integer;
}

export interface DbcPoolDto {
  address: string;
  config: string;
  creator: string;
  baseMint: string;
  /** Lamports. */
  quoteReserve: string;
  /** Token base units. */
  baseReserve: string;
  migrationQuoteThreshold: string;
  /** `quoteReserve / migrationQuoteThreshold`, clamped to 0..1. */
  progress: number;
  isMigrated: boolean;
}

export type PoolRef = { pool: PublicKey } | { mint: PublicKey; config: PublicKey };

export interface CurveQuote {
  amountIn: bigint;
  outAmount: bigint;
  minOut: bigint;
}

export interface MigrateTx {
  transaction: Transaction;
  /** Both position NFT keypairs must co-sign (SDK drift, §4). */
  extraSigners: [Keypair, Keypair];
}

const PROGRESS_SCALE = 1_000_000n;

export type BNValue = ReturnType<typeof convertToLamports>;

export const toBN = (value: bigint): BNValue => convertToLamports(value.toString(), 0);
const big = (value: Integer) => BigInt(value.toString());
const dbc = (connection: Connection) => new DynamicBondingCurveClient(connection, 'confirmed');

export function curveProgress(quoteReserve: bigint, threshold: bigint): number {
  if (threshold <= 0n || quoteReserve <= 0n) return 0;
  if (quoteReserve >= threshold) return 1;
  return Number((quoteReserve * PROGRESS_SCALE) / threshold) / Number(PROGRESS_SCALE);
}

export function normalizePool(
  address: PublicKey,
  pool: VirtualPoolFields,
  config: PoolConfigFields,
): DbcPoolDto {
  const s = pool.poolState;
  const threshold = big(config.migrationQuoteThreshold);
  return {
    address: address.toBase58(),
    config: s.config.toBase58(),
    creator: s.creator.toBase58(),
    baseMint: s.baseMint.toBase58(),
    quoteReserve: s.quoteReserve.toString(),
    baseReserve: s.baseReserve.toString(),
    migrationQuoteThreshold: threshold.toString(),
    progress: curveProgress(big(s.quoteReserve), threshold),
    isMigrated: s.isMigrated !== 0,
  };
}

export function dbcPoolAddress(ref: PoolRef): PublicKey {
  return 'pool' in ref ? ref.pool : deriveDbcPoolAddress(NATIVE_MINT, ref.mint, ref.config);
}

async function poolWithConfig(connection: Connection, address: PublicKey) {
  const client = dbc(connection);
  const pool = await client.state.getPool(address);
  if (!pool) return null;
  const config = await client.state.getPoolConfig(pool.poolState.config);
  if (!config) throw new Error(`DBC config ${pool.poolState.config.toBase58()} not found`);
  return { client, pool, config };
}

export async function readPool(connection: Connection, ref: PoolRef): Promise<DbcPoolDto | null> {
  const address = dbcPoolAddress(ref);
  const found = await poolWithConfig(connection, address);
  return found && normalizePool(address, found.pool, found.config);
}

export interface VerifyLaunchInput {
  signature: string;
  mint: PublicKey;
  expectedConfig: PublicKey;
  expectedCreator: PublicKey;
}

const mismatch = (reason: string) => new AppError('pool_mismatch', { details: { reason } });

/** Accepts a launch only if the tx succeeded and the pool has our config and the owner as creator (L122, L524). */
export async function verifyLaunch(
  connection: Connection,
  { signature, mint, expectedConfig, expectedCreator }: VerifyLaunchInput,
): Promise<{ pool: string }> {
  const { value } = await connection.getSignatureStatuses([signature], {
    searchTransactionHistory: true,
  });
  const status = value[0];
  if (!status || status.err !== null) throw mismatch('launch_tx_failed');

  const address = deriveDbcPoolAddress(NATIVE_MINT, mint, expectedConfig);
  const pool = await dbc(connection).state.getPool(address);
  if (!pool) throw mismatch('pool_not_found');
  if (!pool.poolState.config.equals(expectedConfig)) throw mismatch('config');
  if (!pool.poolState.creator.equals(expectedCreator)) throw mismatch('creator');
  return { pool: address.toBase58() };
}

export async function quoteBuy(
  connection: Connection,
  pool: PublicKey,
  lamports: bigint,
  slippageBps = 0,
): Promise<CurveQuote> {
  const found = await poolWithConfig(connection, pool);
  if (!found) throw new Error(`DBC pool ${pool.toBase58()} not found`);
  const { client, config } = found;
  const currentPoint = await getCurrentPoint(connection, config.activationType);
  const quote = client.pool.swapQuote2({
    virtualPool: found.pool,
    config,
    swapBaseForQuote: false,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
    slippageBps,
    swapMode: SwapMode.PartialFill,
    amountIn: toBN(lamports),
  });
  const outAmount = big(quote.outputAmount);
  return {
    amountIn: lamports,
    outAmount,
    minOut: quote.minimumAmountOut ? big(quote.minimumAmountOut) : outAmount,
  };
}

/** SOL → token buy on the curve; the SDK wraps SOL and creates the ATAs. */
export function buildCurveBuyTx(
  connection: Connection,
  keeper: PublicKey,
  pool: PublicKey,
  lamports: bigint,
  minOut: bigint,
): Promise<Transaction> {
  return dbc(connection).pool.swap2({
    owner: keeper,
    payer: keeper,
    pool,
    swapBaseForQuote: false,
    referralTokenAccount: null,
    swapMode: SwapMode.PartialFill,
    amountIn: toBN(lamports),
    minimumAmountOut: toBN(minOut),
  });
}

export async function buildMigrateTx(
  connection: Connection,
  keeper: PublicKey,
  pool: PublicKey,
): Promise<MigrateTx> {
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await dbc(
    connection,
  ).migration.migrateToDammV2({ payer: keeper, pool, dammConfig: DAMM_V2_CONFIG_100_BPS });
  return { transaction, extraSigners: [firstPositionNftKeypair, secondPositionNftKeypair] };
}

export async function feeMetrics(
  connection: Connection,
  pool: PublicKey,
): Promise<{ totalTradingBaseFee: bigint; totalTradingQuoteFee: bigint }> {
  const { total } = await dbc(connection).state.getPoolFeeMetrics(pool);
  return {
    totalTradingBaseFee: big(total.totalTradingBaseFee),
    totalTradingQuoteFee: big(total.totalTradingQuoteFee),
  };
}
