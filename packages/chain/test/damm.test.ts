import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildAddLiquidity,
  buildClaimPositionFee,
  buildCreatePositionAndAdd,
  buildPermanentLock,
  buildSwap,
  dammPoolDto,
  deriveDammPool,
  depositQuote,
  quoteSwap,
  readDammPool,
  type DammPool,
} from '../src/damm.js';
import {
  CP_AMM_PROGRAM_ID,
  CpAmm,
  DAMM_V2_CONFIG_100_BPS,
  DammSwapMode,
  type DammPoolState,
  derivePoolAddress,
  derivePositionAddress,
  derivePositionNftAccount,
  NATIVE_MINT,
  toBN,
} from '../src/sdk.js';

const CPAMM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const mint = new PublicKey('AeKcMHrG6M4ydgaH9twWRSDQqMQyXJUsBjxBPK3cUv4F');
const owner = Keypair.generate().publicKey;
const address = deriveDammPool(mint);
/** A real devnet add-liquidity delta; 20-digit rounding turned it into …689000000000. */
const U128_LIQUIDITY = 54_216_811_413_822_396_688_848_514_146n;

const state = {
  tokenAMint: mint,
  tokenBMint: NATIVE_MINT,
  tokenAVault: Keypair.generate().publicKey,
  tokenBVault: Keypair.generate().publicKey,
  tokenAFlag: 0,
  tokenBFlag: 0,
  tokenAAmount: toBN(0n),
  tokenBAmount: toBN(0n),
  liquidity: toBN(1_000_000_000_000n),
  sqrtPrice: toBN(18_446_744_073_709_551n),
  sqrtMinPrice: toBN(4_295_048_016n),
  sqrtMaxPrice: toBN(79_226_673_521_066_979_257_578_248_091n),
  collectFeeMode: 1,
  activationType: 1,
} as unknown as DammPoolState;
const pool: DammPool = { address, state };

const positionNft = Keypair.generate().publicKey;
const position = derivePositionAddress(positionNft);
const positionNftAccount = derivePositionNftAccount(positionNft);

const connection = () => new Connection('http://127.0.0.1:1', 'confirmed');
const programIds = (tx: Transaction) => tx.instructions.map((ix) => ix.programId.toBase58());

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deriveDammPool', () => {
  it('derives the migrated pool from the 100 bps config, the base mint and WSOL', () => {
    expect(CP_AMM_PROGRAM_ID.toBase58()).toBe(CPAMM);
    expect(DAMM_V2_CONFIG_100_BPS.toBase58()).toBe('Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp');
    expect(deriveDammPool(mint)).toEqual(deriveDammPool(new PublicKey(mint.toBase58())));
    expect(deriveDammPool(mint)).toEqual(
      derivePoolAddress(DAMM_V2_CONFIG_100_BPS, NATIVE_MINT, mint),
    );
    expect(deriveDammPool(Keypair.generate().publicKey)).not.toEqual(address);
  });
});

describe('reads and quotes', () => {
  it('readDammPool returns null for a missing pool and the state otherwise', async () => {
    const exists = vi.spyOn(CpAmm.prototype, 'isPoolExist').mockResolvedValueOnce(false);
    expect(await readDammPool(connection(), address)).toBeNull();
    exists.mockResolvedValueOnce(true);
    vi.spyOn(CpAmm.prototype, 'fetchPoolState').mockResolvedValue(state);
    expect(await readDammPool(connection(), address)).toEqual(pool);
    expect(dammPoolDto(pool)).toMatchObject({
      address: address.toBase58(),
      tokenAMint: mint.toBase58(),
      tokenBMint: NATIVE_MINT.toBase58(),
      liquidity: '1000000000000',
    });
  });

  it('quoteSwap calls getQuote2 ExactIn with decimals by mint', async () => {
    const conn = connection();
    vi.spyOn(conn, 'getSlot').mockResolvedValue(100);
    vi.spyOn(conn, 'getBlockTime').mockResolvedValue(1_700_000_000);
    const getQuote2 = vi.spyOn(CpAmm.prototype, 'getQuote2').mockReturnValue({
      outputAmount: toBN(900n),
      minimumAmountOut: toBN(891n),
    } as unknown as ReturnType<CpAmm['getQuote2']>);
    const quote = await quoteSwap(conn, pool, {
      inputMint: NATIVE_MINT,
      amountIn: 1_000n,
      slippageBps: 100,
    });
    expect(quote).toEqual({ amountIn: 1_000n, outAmount: 900n, minOut: 891n });
    const params = getQuote2.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      inputTokenMint: NATIVE_MINT,
      slippage: 1,
      poolState: state,
      tokenADecimal: 6,
      tokenBDecimal: 9,
      hasReferral: false,
      swapMode: DammSwapMode.ExactIn,
    });
    expect(params && 'amountIn' in params ? params.amountIn.toString() : null).toBe('1000');
  });

  it('depositQuote passes pool prices and reserves to getDepositQuote', () => {
    const getDepositQuote = vi.spyOn(CpAmm.prototype, 'getDepositQuote').mockReturnValue({
      actualInputAmount: toBN(500n),
      consumedInputAmount: toBN(500n),
      outputAmount: toBN(250n),
      liquidityDelta: toBN(7_000n),
    });
    expect(depositQuote(connection(), pool, { inAmount: 500n, isTokenA: false })).toEqual({
      inAmount: 500n,
      outAmount: 250n,
      liquidityDelta: 7_000n,
    });
    expect(getDepositQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        isTokenA: false,
        sqrtPrice: state.sqrtPrice,
        minSqrtPrice: state.sqrtMinPrice,
        maxSqrtPrice: state.sqrtMaxPrice,
        collectFeeMode: 1,
        liquidity: state.liquidity,
      }),
    );
  });
});

describe('builders', () => {
  it('createPositionAndAdd builds a cp-amm tx with WSOL wrapping and a new NFT signer', async () => {
    const spy = vi.spyOn(CpAmm.prototype, 'createPositionAndAddLiquidity');
    const built = await buildCreatePositionAndAdd(connection(), {
      owner,
      pool,
      liquidityDelta: 7_000n,
      maxAmountTokenA: 100n,
      maxAmountTokenB: 200n,
    });
    expect(programIds(built.transaction)).toContain(CPAMM);
    expect(programIds(built.transaction)).toContain(SystemProgram.programId.toBase58());
    const [nft] = built.extraSigners;
    expect(built.position).toEqual(derivePositionAddress(nft.publicKey));
    expect(built.positionNftAccount).toEqual(derivePositionNftAccount(nft.publicKey));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        owner,
        pool: address,
        positionNft: nft.publicKey,
        tokenAMint: mint,
        tokenBMint: NATIVE_MINT,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
      }),
    );
  });

  it('addLiquidity targets the existing position and vaults', async () => {
    const spy = vi.spyOn(CpAmm.prototype, 'addLiquidity');
    const tx = await buildAddLiquidity(connection(), {
      owner,
      pool,
      position,
      positionNftAccount,
      liquidityDelta: U128_LIQUIDITY,
      maxAmountTokenA: 100n,
      maxAmountTokenB: 200n,
    });
    expect(programIds(tx)).toContain(CPAMM);
    const params = spy.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      owner,
      pool: address,
      position,
      positionNftAccount,
      tokenAVault: state.tokenAVault,
      tokenBVault: state.tokenBVault,
    });
    expect(params?.liquidityDelta.toString()).toBe('54216811413822396688848514146');
    expect(params?.maxAmountTokenB.toString()).toBe('200');
  });

  it('permanentLock locks the given liquidity', async () => {
    const spy = vi.spyOn(CpAmm.prototype, 'permanentLockPosition');
    const tx = await buildPermanentLock(connection(), {
      owner,
      pool,
      position,
      positionNftAccount,
      unlockedLiquidity: U128_LIQUIDITY,
    });
    expect(programIds(tx)).toEqual([CPAMM]);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ owner, pool: address, position });
    expect(spy.mock.calls[0]?.[0].unlockedLiquidity.toString()).toBe(
      '54216811413822396688848514146',
    );
  });

  it('claimPositionFee claims to the owner', async () => {
    const spy = vi.spyOn(CpAmm.prototype, 'claimPositionFee');
    const tx = await buildClaimPositionFee(connection(), {
      owner,
      pool,
      position,
      positionNftAccount,
    });
    expect(programIds(tx)).toContain(CPAMM);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      owner,
      pool: address,
      position,
      positionNftAccount,
      tokenAMint: mint,
      tokenBMint: NATIVE_MINT,
    });
  });

  it('swap passes the cached pool state to swap2 ExactIn', async () => {
    const tx = new Transaction();
    const swap2 = vi.spyOn(CpAmm.prototype, 'swap2').mockResolvedValue(tx);
    expect(
      await buildSwap(connection(), {
        payer: owner,
        pool,
        inputMint: NATIVE_MINT,
        amountIn: 1_000n,
        minOut: 891n,
      }),
    ).toBe(tx);
    const params = swap2.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      payer: owner,
      pool: address,
      inputTokenMint: NATIVE_MINT,
      outputTokenMint: mint,
      referralTokenAccount: null,
      poolState: state,
      swapMode: DammSwapMode.ExactIn,
    });
    expect(params && 'minimumAmountOut' in params ? params.minimumAmountOut.toString() : null).toBe(
      '891',
    );
  });
});
