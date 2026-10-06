import { AppError } from '@ibt/shared';
import type {
  Connection,
  Keypair,
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

import { readTokenMetadata } from './metadata.js';

import {
  DAMM_V2_CONFIG_100_BPS,
  DBC_PROGRAM_ID,
  deriveDbcPoolAddress,
  DynamicBondingCurveClient,
  getCurrentPoint,
  NATIVE_MINT,
  SwapMode,
  toBN,
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
    baseVault: PublicKey;
    quoteVault: PublicKey;
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

export interface ExpectedTokenMetadata {
  name?: string;
  symbol?: string;
  uri?: string;
}

export interface VerifyLaunchInput {
  signature: string;
  mint: PublicKey;
  expectedConfig: PublicKey;
  expectedCreator: PublicKey;
  /** When set, the mint's Metaplex metadata must exist and match every given field exactly (API-06). */
  expectedMetadata?: ExpectedTokenMetadata;
}

/**
 * `details.reason` of the `pool_mismatch` thrown by `verifyLaunch`. `tx_*` bind the
 * signature, `pool_not_found`/`config`/`creator` check the pool, `metadata_*` the token.
 */
export type LaunchMismatchReason =
  | 'tx_not_found'
  | 'tx_failed'
  | 'tx_not_launch'
  | 'pool_not_found'
  | 'config'
  | 'creator'
  | 'metadata_not_found'
  | 'metadata_name'
  | 'metadata_symbol'
  | 'metadata_uri';

const mismatch = (reason: LaunchMismatchReason) =>
  new AppError('pool_mismatch', { details: { reason } });

/**
 * Anchor discriminators of DBC's `initialize_virtual_pool_with_{spl_token,token2022,
 * token2022_transfer_hook}` (SDK 1.5.13 IDL). All three take `config, pool_authority,
 * creator, base_mint, quote_mint, pool, …` as their first accounts.
 */
const INIT_POOL_DISCRIMINATORS = [
  [140, 85, 215, 176, 102, 54, 104, 79],
  [169, 118, 51, 78, 145, 110, 220, 155],
  [182, 13, 233, 177, 42, 145, 135, 2],
].map((bytes) => Buffer.from(bytes).toString('hex'));
const INIT_ACCOUNT = { config: 0, creator: 2, baseMint: 3, pool: 5 } as const;

type AnyInstruction = ParsedInstruction | PartiallyDecodedInstruction;

function decodedData(ix: PartiallyDecodedInstruction): Buffer | null {
  try {
    return Buffer.from(bs58.decode(ix.data));
  } catch (err) {
    if (err instanceof Error) return null;
    throw err;
  }
}

/** True when the tx (top-level or CPI) runs a DBC pool init for exactly this pool, mint, config and creator. */
export function initializesPool(
  tx: ParsedTransactionWithMeta,
  expected: { pool: PublicKey; mint: PublicKey; config: PublicKey; creator: PublicKey },
): boolean {
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions);
  const instructions: AnyInstruction[] = [...tx.transaction.message.instructions, ...inner];
  return instructions.some((ix) => {
    if ('parsed' in ix || !ix.programId.equals(DBC_PROGRAM_ID)) return false;
    const data = decodedData(ix);
    if (!data || !INIT_POOL_DISCRIMINATORS.includes(data.subarray(0, 8).toString('hex'))) {
      return false;
    }
    const at = (i: number) => ix.accounts[i];
    return (
      at(INIT_ACCOUNT.config)?.equals(expected.config) === true &&
      at(INIT_ACCOUNT.creator)?.equals(expected.creator) === true &&
      at(INIT_ACCOUNT.baseMint)?.equals(expected.mint) === true &&
      at(INIT_ACCOUNT.pool)?.equals(expected.pool) === true
    );
  });
}

/**
 * Accepts a launch only if `signature` is a successful tx, at `confirmed` or stronger,
 * that initialized the pool derived from `mint` and our config with the owner as creator,
 * and the pool account agrees (L122, L524). Throws `pool_mismatch` with
 * `details.reason: LaunchMismatchReason`.
 */
export async function verifyLaunch(
  connection: Connection,
  { signature, mint, expectedConfig, expectedCreator, expectedMetadata }: VerifyLaunchInput,
): Promise<{ pool: string }> {
  const address = deriveDbcPoolAddress(NATIVE_MINT, mint, expectedConfig);
  const tx = await connection.getParsedTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta) throw mismatch('tx_not_found');
  if (tx.meta.err !== null) throw mismatch('tx_failed');
  const expected = { pool: address, mint, config: expectedConfig, creator: expectedCreator };
  if (!initializesPool(tx, expected)) throw mismatch('tx_not_launch');

  const pool = await dbc(connection).state.getPool(address);
  if (!pool) throw mismatch('pool_not_found');
  if (!pool.poolState.config.equals(expectedConfig)) throw mismatch('config');
  if (!pool.poolState.creator.equals(expectedCreator)) throw mismatch('creator');

  if (expectedMetadata) {
    const metadata = await readTokenMetadata(connection, mint);
    if (!metadata) throw mismatch('metadata_not_found');
    const { name, symbol, uri } = expectedMetadata;
    if (name !== undefined && metadata.name !== name) throw mismatch('metadata_name');
    if (symbol !== undefined && metadata.symbol !== symbol) throw mismatch('metadata_symbol');
    if (uri !== undefined && metadata.uri !== uri) throw mismatch('metadata_uri');
  }
  return { pool: address.toBase58() };
}

export interface CurveVaults {
  baseMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
}

export async function readCurveVaults(
  connection: Connection,
  pool: PublicKey,
): Promise<CurveVaults> {
  const found = await dbc(connection).state.getPool(pool);
  if (!found) throw new Error(`DBC pool ${pool.toBase58()} not found`);
  const { baseMint, baseVault, quoteVault } = found.poolState;
  return { baseMint, baseVault, quoteVault };
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

export interface CurveSwapQuote {
  amountIn: bigint;
  outAmount: bigint;
  /** Trading fee charged by the pool, in the fee token's base units. */
  fee: bigint;
}

/** Display quote for either side of the curve: `buy` spends lamports, `sell` spends tokens. */
export async function quoteCurveSwap(
  connection: Connection,
  pool: PublicKey,
  { side, amountIn }: { side: 'buy' | 'sell'; amountIn: bigint },
): Promise<CurveSwapQuote> {
  const found = await poolWithConfig(connection, pool);
  if (!found) throw new Error(`DBC pool ${pool.toBase58()} not found`);
  const { client, config } = found;
  const currentPoint = await getCurrentPoint(connection, config.activationType);
  const quote = client.pool.swapQuote2({
    virtualPool: found.pool,
    config,
    swapBaseForQuote: side === 'sell',
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
    slippageBps: 0,
    swapMode: side === 'buy' ? SwapMode.PartialFill : SwapMode.ExactIn,
    amountIn: toBN(amountIn),
  });
  return { amountIn, outAmount: big(quote.outputAmount), fee: big(quote.tradingFee) };
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
