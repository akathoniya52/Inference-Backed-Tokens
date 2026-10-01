import { AppError } from '@ibt/shared';
import {
  type PoolConfig,
  PoolService,
  StateService,
  SwapMode,
  type SwapQuote2Result,
  type VirtualPool,
  MigrationService,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionError,
} from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCurveBuyTx,
  buildMigrateTx,
  curveProgress,
  feeMetrics,
  normalizePool,
  quoteBuy,
  readPool,
  verifyLaunch,
} from '../src/dbc.js';
import { DAMM_V2_CONFIG_100_BPS, deriveDbcPoolAddress, NATIVE_MINT } from '../src/sdk.js';
import { loadAccountFixture } from './fixtures/load.js';

const pool = loadAccountFixture('dbc-pool') as VirtualPool;
const config = loadAccountFixture('dbc-config') as PoolConfig;
const ourConfig = pool.poolState.config;
const owner = pool.poolState.creator;
const mint = pool.poolState.baseMint;
const poolAddress = deriveDbcPoolAddress(NATIVE_MINT, mint, ourConfig);
const keeper = Keypair.generate().publicKey;

function connection(): Connection {
  return new Connection('http://127.0.0.1:1', 'confirmed');
}

function stubState(found: VirtualPool | null = pool) {
  const getPool = vi.spyOn(StateService.prototype, 'getPool').mockResolvedValue(found);
  vi.spyOn(StateService.prototype, 'getPoolConfig').mockResolvedValue(config);
  return getPool;
}

function stubLaunchTx(conn: Connection, err: TransactionError | null = null) {
  return vi.spyOn(conn, 'getSignatureStatuses').mockResolvedValue({
    context: { slot: 1 },
    value: [{ slot: 1, confirmations: null, err, confirmationStatus: 'finalized' }],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('curve progress', () => {
  it('is quoteReserve / migrationQuoteThreshold, clamped to 0..1', () => {
    expect(curveProgress(2_500_000_000n, 10_000_000_000n)).toBe(0.25);
    expect(curveProgress(12_000_000_000n, 10_000_000_000n)).toBe(1);
    expect(curveProgress(0n, 10_000_000_000n)).toBe(0);
    expect(curveProgress(5n, 0n)).toBe(0);
  });

  it('normalizes a pool fixture to string base units', () => {
    expect(normalizePool(poolAddress, pool, config)).toEqual({
      address: poolAddress.toBase58(),
      config: ourConfig.toBase58(),
      creator: owner.toBase58(),
      baseMint: mint.toBase58(),
      quoteReserve: '2500000000',
      baseReserve: '650000000000000',
      migrationQuoteThreshold: '10000000000',
      progress: 0.25,
      isMigrated: false,
    });
  });
});

describe('readPool', () => {
  it('reads by mint through the derived pool address', async () => {
    const getPool = stubState();
    const dto = await readPool(connection(), { mint, config: ourConfig });
    expect(getPool).toHaveBeenCalledWith(poolAddress);
    expect(dto?.progress).toBe(0.25);
  });

  it('returns null when the pool does not exist', async () => {
    stubState(null);
    expect(await readPool(connection(), { pool: poolAddress })).toBeNull();
  });
});

describe('verifyLaunch', () => {
  const input = { signature: 'sig', mint, expectedConfig: ourConfig, expectedCreator: owner };

  it('accepts a pool with our config and the model owner as creator', async () => {
    const conn = connection();
    stubLaunchTx(conn);
    stubState();
    await expect(verifyLaunch(conn, input)).resolves.toEqual({
      pool: poolAddress.toBase58(),
    });
  });

  it.each([
    ['a failed launch tx', { txErr: 'AccountNotFound' as TransactionError }],
    ['a foreign creator', { creator: Keypair.generate().publicKey }],
    ['a missing pool', { missing: true }],
  ])('rejects %s with pool_mismatch', async (_label, c) => {
    const conn = connection();
    stubLaunchTx(conn, 'txErr' in c ? c.txErr : null);
    const poolState = { ...pool.poolState, creator: 'creator' in c ? c.creator : owner };
    stubState('missing' in c ? null : { poolState });
    const err = await verifyLaunch(conn, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'pool_mismatch' });
  });

  it('rejects a pool whose config is not ours', async () => {
    const conn = connection();
    stubLaunchTx(conn);
    const foreign = Keypair.generate().publicKey;
    const getPool = stubState();
    const err = await verifyLaunch(conn, { ...input, expectedConfig: foreign }).catch(
      (e: unknown) => e,
    );
    expect(getPool).toHaveBeenCalledWith(deriveDbcPoolAddress(NATIVE_MINT, mint, foreign));
    expect(err).toMatchObject({ code: 'pool_mismatch' });
  });
});

describe('builders', () => {
  it('quoteBuy calls swapQuote2 in PartialFill mode for a SOL→token buy', async () => {
    const conn = connection();
    stubState();
    vi.spyOn(conn, 'getSlot').mockResolvedValue(100);
    vi.spyOn(conn, 'getBlockTime').mockResolvedValue(1_700_000_000);
    const swapQuote2 = vi.spyOn(PoolService.prototype, 'swapQuote2').mockReturnValue({
      outputAmount: { toString: () => '123456' },
      minimumAmountOut: { toString: () => '122000' },
    } as SwapQuote2Result);
    const quote = await quoteBuy(conn, poolAddress, 500_000_000n, 100);
    expect(quote).toEqual({ amountIn: 500_000_000n, outAmount: 123_456n, minOut: 122_000n });
    const params = swapQuote2.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      virtualPool: pool,
      config,
      swapBaseForQuote: false,
      hasReferral: false,
      swapMode: SwapMode.PartialFill,
      slippageBps: 100,
    });
    expect(params && 'amountIn' in params ? params.amountIn.toString() : null).toBe('500000000');
    expect(params?.currentPoint.toString()).toBe('1700000000');
  });

  it('buildCurveBuyTx calls swap2 with the keeper as owner and payer', async () => {
    const tx = new Transaction();
    const swap2 = vi.spyOn(PoolService.prototype, 'swap2').mockResolvedValue(tx);
    expect(await buildCurveBuyTx(connection(), keeper, poolAddress, 500_000_000n, 122_000n)).toBe(
      tx,
    );
    const params = swap2.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      owner: keeper,
      payer: keeper,
      pool: poolAddress,
      swapBaseForQuote: false,
      referralTokenAccount: null,
      swapMode: SwapMode.PartialFill,
    });
    expect(params && 'amountIn' in params ? params.amountIn.toString() : null).toBe('500000000');
    expect(params && 'minimumAmountOut' in params ? params.minimumAmountOut.toString() : null).toBe(
      '122000',
    );
  });

  it('buildMigrateTx uses { payer, pool, dammConfig } and returns both NFT signers', async () => {
    const transaction = new Transaction();
    const firstPositionNftKeypair = Keypair.generate();
    const secondPositionNftKeypair = Keypair.generate();
    const migrate = vi
      .spyOn(MigrationService.prototype, 'migrateToDammV2')
      .mockResolvedValue({ transaction, firstPositionNftKeypair, secondPositionNftKeypair });
    const built = await buildMigrateTx(connection(), keeper, poolAddress);
    expect(migrate).toHaveBeenCalledWith({
      payer: keeper,
      pool: poolAddress,
      dammConfig: DAMM_V2_CONFIG_100_BPS,
    });
    expect(DAMM_V2_CONFIG_100_BPS).toEqual(
      new PublicKey('Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp'),
    );
    expect(built).toEqual({
      transaction,
      extraSigners: [firstPositionNftKeypair, secondPositionNftKeypair],
    });
  });

  it('feeMetrics reads lifetime totals from getPoolFeeMetrics', async () => {
    stubState();
    await expect(feeMetrics(connection(), poolAddress)).resolves.toEqual({
      totalTradingBaseFee: 0n,
      totalTradingQuoteFee: 42_000_000n,
    });
  });
});
