import { TOKEN_DECIMALS, SOL_DECIMALS } from '@ibt/shared';
import { type Connection, Keypair, type PublicKey, type Transaction } from '@solana/web3.js';

import {
  CpAmm,
  DAMM_V2_CONFIG_100_BPS,
  type DammPoolState,
  DammSwapMode,
  derivePoolAddress,
  derivePositionAddress,
  derivePositionNftAccount,
  getDammCurrentPoint,
  getTokenProgram,
  NATIVE_MINT,
  toBN,
} from './sdk.js';

export interface DammPool {
  address: PublicKey;
  state: DammPoolState;
}

export interface DammPoolDto {
  address: string;
  tokenAMint: string;
  tokenBMint: string;
  liquidity: string;
  sqrtPrice: string;
}

export interface PositionRef {
  owner: PublicKey;
  pool: DammPool;
  position: PublicKey;
  positionNftAccount: PublicKey;
}

export interface LiquidityAmounts {
  liquidityDelta: bigint;
  maxAmountTokenA: bigint;
  maxAmountTokenB: bigint;
}

export interface SwapQuote {
  amountIn: bigint;
  outAmount: bigint;
  minOut: bigint;
}

const cpAmm = (connection: Connection) => new CpAmm(connection);
const big = (value: { toString(): string }) => BigInt(value.toString());

/**
 * The migrated pool for a model token: config `Hv8Lmz…cjp`, base mint, WSOL.
 * `derivePoolAddress` sorts the two mints itself (verified in P2-T1), so the
 * argument order does not matter.
 */
export function deriveDammPool(mint: PublicKey): PublicKey {
  return derivePoolAddress(DAMM_V2_CONFIG_100_BPS, mint, NATIVE_MINT);
}

export async function readDammPool(
  connection: Connection,
  address: PublicKey,
): Promise<DammPool | null> {
  const client = cpAmm(connection);
  if (!(await client.isPoolExist(address))) return null;
  return { address, state: await client.fetchPoolState(address) };
}

export function dammPoolDto({ address, state }: DammPool): DammPoolDto {
  return {
    address: address.toBase58(),
    tokenAMint: state.tokenAMint.toBase58(),
    tokenBMint: state.tokenBMint.toBase58(),
    liquidity: state.liquidity.toString(),
    sqrtPrice: state.sqrtPrice.toString(),
  };
}

const decimalsOf = (mint: PublicKey) => (mint.equals(NATIVE_MINT) ? SOL_DECIMALS : TOKEN_DECIMALS);

function tokens({ state }: DammPool) {
  return {
    tokenAMint: state.tokenAMint,
    tokenBMint: state.tokenBMint,
    tokenAProgram: getTokenProgram(state.tokenAFlag),
    tokenBProgram: getTokenProgram(state.tokenBFlag),
  };
}

export async function quoteSwap(
  connection: Connection,
  pool: DammPool,
  {
    inputMint,
    amountIn,
    slippageBps = 0,
  }: { inputMint: PublicKey; amountIn: bigint; slippageBps?: number },
): Promise<SwapQuote> {
  const { state } = pool;
  const currentPoint = await getDammCurrentPoint(connection, state.activationType);
  const quote = cpAmm(connection).getQuote2({
    inputTokenMint: inputMint,
    slippage: slippageBps / 100,
    currentPoint,
    poolState: state,
    tokenADecimal: decimalsOf(state.tokenAMint),
    tokenBDecimal: decimalsOf(state.tokenBMint),
    hasReferral: false,
    swapMode: DammSwapMode.ExactIn,
    amountIn: toBN(amountIn),
  });
  const outAmount = big(quote.outputAmount);
  return {
    amountIn,
    outAmount,
    minOut: quote.minimumAmountOut ? big(quote.minimumAmountOut) : outAmount,
  };
}

export interface DammSwapQuote extends SwapQuote {
  /** LP (claiming + compounding), protocol and referral fees, in the fee token's base units. */
  fee: bigint;
  priceImpactPct: number;
}

/** `quoteSwap` plus the fee and price impact, for display quotes. */
export async function quoteSwapDetailed(
  connection: Connection,
  pool: DammPool,
  { inputMint, amountIn }: { inputMint: PublicKey; amountIn: bigint },
): Promise<DammSwapQuote> {
  const { state } = pool;
  const currentPoint = await getDammCurrentPoint(connection, state.activationType);
  const quote = cpAmm(connection).getQuote2({
    inputTokenMint: inputMint,
    slippage: 0,
    currentPoint,
    poolState: state,
    tokenADecimal: decimalsOf(state.tokenAMint),
    tokenBDecimal: decimalsOf(state.tokenBMint),
    hasReferral: false,
    swapMode: DammSwapMode.ExactIn,
    amountIn: toBN(amountIn),
  });
  const outAmount = big(quote.outputAmount);
  return {
    amountIn,
    outAmount,
    minOut: outAmount,
    fee:
      big(quote.claimingFee) +
      big(quote.compoundingFee) +
      big(quote.protocolFee) +
      big(quote.referralFee),
    priceImpactPct: Number(quote.priceImpact.toString()),
  };
}

export function depositQuote(
  connection: Connection,
  { state }: DammPool,
  { inAmount, isTokenA }: { inAmount: bigint; isTokenA: boolean },
): { inAmount: bigint; outAmount: bigint; liquidityDelta: bigint } {
  const quote = cpAmm(connection).getDepositQuote({
    inAmount: toBN(inAmount),
    isTokenA,
    minSqrtPrice: state.sqrtMinPrice,
    maxSqrtPrice: state.sqrtMaxPrice,
    sqrtPrice: state.sqrtPrice,
    collectFeeMode: state.collectFeeMode,
    tokenAAmount: state.tokenAAmount,
    tokenBAmount: state.tokenBAmount,
    liquidity: state.liquidity,
  });
  return {
    inAmount: big(quote.consumedInputAmount),
    outAmount: big(quote.outputAmount),
    liquidityDelta: big(quote.liquidityDelta),
  };
}

const liquidityParams = (a: LiquidityAmounts) => ({
  liquidityDelta: toBN(a.liquidityDelta),
  maxAmountTokenA: toBN(a.maxAmountTokenA),
  maxAmountTokenB: toBN(a.maxAmountTokenB),
  tokenAAmountThreshold: toBN(a.maxAmountTokenA),
  tokenBAmountThreshold: toBN(a.maxAmountTokenB),
});

export interface CreatePositionTx {
  transaction: Transaction;
  /** The position NFT mint must co-sign. */
  extraSigners: [Keypair];
  position: PublicKey;
  positionNftAccount: PublicKey;
}

/** The SDK wraps SOL into the owner's WSOL ATA and closes it afterwards. */
export async function buildCreatePositionAndAdd(
  connection: Connection,
  { owner, pool, ...amounts }: { owner: PublicKey; pool: DammPool } & LiquidityAmounts,
): Promise<CreatePositionTx> {
  const nft = Keypair.generate();
  const transaction = await cpAmm(connection).createPositionAndAddLiquidity({
    owner,
    pool: pool.address,
    positionNft: nft.publicKey,
    ...liquidityParams(amounts),
    ...tokens(pool),
  });
  return {
    transaction,
    extraSigners: [nft],
    position: derivePositionAddress(nft.publicKey),
    positionNftAccount: derivePositionNftAccount(nft.publicKey),
  };
}

export function buildAddLiquidity(
  connection: Connection,
  { owner, pool, position, positionNftAccount, ...amounts }: PositionRef & LiquidityAmounts,
): Promise<Transaction> {
  return cpAmm(connection).addLiquidity({
    owner,
    pool: pool.address,
    position,
    positionNftAccount,
    ...liquidityParams(amounts),
    ...tokens(pool),
    tokenAVault: pool.state.tokenAVault,
    tokenBVault: pool.state.tokenBVault,
  });
}

export function buildPermanentLock(
  connection: Connection,
  {
    owner,
    pool,
    position,
    positionNftAccount,
    unlockedLiquidity,
  }: PositionRef & { unlockedLiquidity: bigint },
): Promise<Transaction> {
  return cpAmm(connection).permanentLockPosition({
    owner,
    pool: pool.address,
    position,
    positionNftAccount,
    unlockedLiquidity: toBN(unlockedLiquidity),
  });
}

export function buildClaimPositionFee(
  connection: Connection,
  { owner, pool, position, positionNftAccount }: PositionRef,
): Promise<Transaction> {
  return cpAmm(connection).claimPositionFee({
    owner,
    pool: pool.address,
    position,
    positionNftAccount,
    ...tokens(pool),
    tokenAVault: pool.state.tokenAVault,
    tokenBVault: pool.state.tokenBVault,
  });
}

export function buildSwap(
  connection: Connection,
  {
    payer,
    pool,
    inputMint,
    amountIn,
    minOut,
  }: { payer: PublicKey; pool: DammPool; inputMint: PublicKey; amountIn: bigint; minOut: bigint },
): Promise<Transaction> {
  const { state } = pool;
  return cpAmm(connection).swap2({
    payer,
    pool: pool.address,
    inputTokenMint: inputMint,
    outputTokenMint: inputMint.equals(state.tokenAMint) ? state.tokenBMint : state.tokenAMint,
    ...tokens(pool),
    tokenAVault: state.tokenAVault,
    tokenBVault: state.tokenBVault,
    referralTokenAccount: null,
    poolState: state,
    swapMode: DammSwapMode.ExactIn,
    amountIn: toBN(amountIn),
    minimumAmountOut: toBN(minOut),
  });
}
