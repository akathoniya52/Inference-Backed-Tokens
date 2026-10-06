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
  type ParsedTransactionWithMeta,
  PublicKey,
  Transaction,
  type TransactionError,
} from '@solana/web3.js';
import bs58 from 'bs58';
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
import { metadataAddress, METAPLEX_METADATA_PROGRAM_ID } from '../src/metadata.js';
import {
  DAMM_V2_CONFIG_100_BPS,
  DBC_PROGRAM_ID,
  deriveDbcPoolAddress,
  NATIVE_MINT,
} from '../src/sdk.js';
import { loadAccountFixture } from '../src/testing/fixtures.js';

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

const INIT_SPL = [140, 85, 215, 176, 102, 54, 104, 79];

function launchIx(
  accounts: { pool?: PublicKey; mint?: PublicKey; config?: PublicKey; programId?: PublicKey } = {},
) {
  return {
    programId: accounts.programId ?? DBC_PROGRAM_ID,
    accounts: [
      accounts.config ?? ourConfig,
      Keypair.generate().publicKey,
      owner,
      accounts.mint ?? mint,
      NATIVE_MINT,
      accounts.pool ?? poolAddress,
    ],
    data: bs58.encode(Buffer.from([...INIT_SPL, 1, 2, 3])),
  };
}

function launchTx(
  err: TransactionError | null = null,
  ix: ReturnType<typeof launchIx> = launchIx(),
  inner = false,
): ParsedTransactionWithMeta {
  return {
    slot: 1,
    blockTime: null,
    transaction: {
      signatures: ['sig'],
      message: { accountKeys: [], instructions: inner ? [] : [ix], recentBlockhash: 'x' },
    },
    meta: {
      err,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      innerInstructions: inner ? [{ index: 0, instructions: [ix] }] : [],
    },
  };
}

function stubLaunchTx(
  conn: Connection,
  err: TransactionError | null = null,
  tx: ParsedTransactionWithMeta | null = launchTx(err),
) {
  return vi.spyOn(conn, 'getParsedTransaction').mockResolvedValue(tx);
}

function metadataAccount(fields: { name: string; symbol: string; uri: string }) {
  const str = (text: string, padTo: number) => {
    const bytes = Buffer.alloc(padTo);
    Buffer.from(text).copy(bytes);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(padTo);
    return Buffer.concat([len, bytes]);
  };
  const data = Buffer.concat([
    Buffer.from([4]),
    Keypair.generate().publicKey.toBuffer(),
    mint.toBuffer(),
    str(fields.name, 32),
    str(fields.symbol, 10),
    str(fields.uri, 200),
    Buffer.from([0, 0, 0, 0, 0]),
  ]);
  return {
    data,
    owner: METAPLEX_METADATA_PROGRAM_ID,
    executable: false,
    lamports: 1,
    rentEpoch: 0,
  };
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

  it('fetches the launch tx at confirmed', async () => {
    const conn = connection();
    const getTx = stubLaunchTx(conn);
    stubState();
    await verifyLaunch(conn, input);
    expect(getTx).toHaveBeenCalledWith('sig', {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
  });

  it('accepts a launch made through a CPI', async () => {
    const conn = connection();
    stubLaunchTx(conn, null, launchTx(null, launchIx(), true));
    stubState();
    await expect(verifyLaunch(conn, input)).resolves.toEqual({ pool: poolAddress.toBase58() });
  });

  it.each([
    ['tx_not_found', null],
    ['tx_failed', launchTx('AccountNotFound')],
    ['tx_not_launch', launchTx(null, launchIx({ programId: Keypair.generate().publicKey }))],
    ['tx_not_launch', launchTx(null, launchIx({ pool: Keypair.generate().publicKey }))],
    ['tx_not_launch', launchTx(null, launchIx({ mint: Keypair.generate().publicKey }))],
  ])('rejects the signature with reason %s', async (reason, tx) => {
    const conn = connection();
    stubLaunchTx(conn, null, tx);
    const getPool = stubState();
    const err = await verifyLaunch(conn, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'pool_mismatch', details: { reason } });
    expect(getPool).not.toHaveBeenCalled();
  });

  it('checks the Metaplex metadata when expected values are given', async () => {
    const conn = connection();
    stubLaunchTx(conn);
    stubState();
    const expectedMetadata = { name: 'Model', symbol: 'MDL', uri: 'https://x.test/m.json' };
    const getAccountInfo = vi
      .spyOn(conn, 'getAccountInfo')
      .mockResolvedValue(metadataAccount(expectedMetadata));
    await expect(verifyLaunch(conn, { ...input, expectedMetadata })).resolves.toEqual({
      pool: poolAddress.toBase58(),
    });
    expect(getAccountInfo).toHaveBeenCalledWith(metadataAddress(mint));

    const wrong = await verifyLaunch(conn, {
      ...input,
      expectedMetadata: { ...expectedMetadata, symbol: 'USDC' },
    }).catch((e: unknown) => e);
    expect(wrong).toMatchObject({ details: { reason: 'metadata_symbol' } });

    getAccountInfo.mockResolvedValue(null);
    const missing = await verifyLaunch(conn, { ...input, expectedMetadata }).catch(
      (e: unknown) => e,
    );
    expect(missing).toMatchObject({ details: { reason: 'metadata_not_found' } });
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
    const foreign = Keypair.generate().publicKey;
    const foreignPool = deriveDbcPoolAddress(NATIVE_MINT, mint, foreign);
    stubLaunchTx(conn, null, launchTx(null, launchIx({ config: foreign, pool: foreignPool })));
    const getPool = stubState();
    const err = await verifyLaunch(conn, { ...input, expectedConfig: foreign }).catch(
      (e: unknown) => e,
    );
    expect(getPool).toHaveBeenCalledWith(foreignPool);
    expect(err).toMatchObject({ code: 'pool_mismatch', details: { reason: 'config' } });
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
