import {
  CpAmm,
  getCurrentPoint as getDammCurrentPoint,
  getTokenProgram,
  SwapMode as DammSwapMode,
} from '@meteora-ag/cp-amm-sdk';
import {
  DynamicBondingCurveClient,
  getCurrentPoint,
  SwapMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { SOL_DECIMALS, TOKEN_DECIMALS, WSOL_MINT } from '@ibt/shared';
import { PublicKey, type Connection, type Transaction } from '@solana/web3.js';
import BN from 'bn.js';

import { env } from '../env';

// Browser-side quotes and swap builders (spec L122–123, L492). Curve phase
// goes through the DBC SDK, graduated tokens through cp-amm (DAMM v2).

export type TradeSide = 'buy' | 'sell';

/** Pool and mint come from the API; every quote checks them against the chain. */
export type TradeTarget =
  | { phase: 'curve'; pool: PublicKey; mint: PublicKey }
  | { phase: 'graduated'; pool: PublicKey; mint: PublicKey };

export interface TradeRequest {
  side: TradeSide;
  /** Lamports when buying, token base units when selling. */
  amountIn: bigint;
  slippageBps: number;
}

export interface TradeOrder extends TradeRequest {
  /** The "Minimum received" the user was shown; the swap never signs for less. */
  minOut: bigint;
}

export interface TradeQuote {
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  /** Ratio (0.012 = 1.2%); `null` when the SDK gives nothing to derive it from. */
  priceImpact: number | null;
}

export const NATIVE_MINT = new PublicKey(WSOL_MINT);

export function inputDecimals(side: TradeSide): number {
  return side === 'buy' ? SOL_DECIMALS : TOKEN_DECIMALS;
}

export function outputDecimals(side: TradeSide): number {
  return side === 'buy' ? TOKEN_DECIMALS : SOL_DECIMALS;
}

/** Exact; the SDKs' `convertToLamports` rounds to 20 significant digits. */
const toBN = (value: bigint) => new BN(value.toString());
const big = (value: { toString(): string }): bigint => BigInt(value.toString());

const IMPACT_SCALE = 1_000_000n;

/** Spot price moves with sqrtPrice², so impact = |(next / current)² − 1|. */
export function sqrtPriceImpact(current: bigint, next: bigint): number | null {
  if (current <= 0n || next <= 0n) return null;
  const scaled = (next * next * IMPACT_SCALE) / (current * current);
  return Math.abs(Number(scaled) / Number(IMPACT_SCALE) - 1);
}

function dbc(connection: Connection) {
  return new DynamicBondingCurveClient(connection, 'confirmed');
}

function assertCurvePool(pool: { config: PublicKey; baseMint: PublicKey }, mint: PublicKey) {
  if (!pool.config.equals(new PublicKey(env.VITE_DBC_CONFIG))) {
    throw new Error('This pool is not on the platform bonding curve config.');
  }
  if (!pool.baseMint.equals(mint)) throw new Error("This pool's base mint is not this token.");
}

async function quoteCurve(
  connection: Connection,
  target: Extract<TradeTarget, { phase: 'curve' }>,
  request: TradeRequest,
) {
  const client = dbc(connection);
  const virtualPool = await client.state.getPool(target.pool);
  if (!virtualPool) throw new Error('Bonding curve pool not found.');
  assertCurvePool(virtualPool.poolState, target.mint);
  const config = await client.state.getPoolConfig(virtualPool.poolState.config);
  if (!config) throw new Error('Bonding curve config not found.');
  const currentPoint = await getCurrentPoint(connection, config.activationType);
  const quote = client.pool.swapQuote2({
    virtualPool,
    config,
    swapBaseForQuote: request.side === 'sell',
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
    slippageBps: request.slippageBps,
    swapMode: SwapMode.PartialFill,
    amountIn: toBN(request.amountIn),
  });
  const amountOut = big(quote.outputAmount);
  return {
    amountIn: request.amountIn,
    amountOut,
    minOut: quote.minimumAmountOut ? big(quote.minimumAmountOut) : amountOut,
    priceImpact: sqrtPriceImpact(big(virtualPool.poolState.sqrtPrice), big(quote.nextSqrtPrice)),
  } satisfies TradeQuote;
}

async function dammPool(connection: Connection, pool: PublicKey) {
  const client = new CpAmm(connection);
  return { client, state: await client.fetchPoolState(pool) };
}

function inputMint(side: TradeSide, mint: PublicKey): PublicKey {
  return side === 'buy' ? NATIVE_MINT : mint;
}

const decimalsOf = (mint: PublicKey) => (mint.equals(NATIVE_MINT) ? SOL_DECIMALS : TOKEN_DECIMALS);

/** Quotes, decimals and the buy side all assume the token is paired with SOL. */
function assertDammPool(state: { tokenAMint: PublicKey; tokenBMint: PublicKey }, mint: PublicKey) {
  const { tokenAMint: a, tokenBMint: b } = state;
  if (!((a.equals(mint) && b.equals(NATIVE_MINT)) || (b.equals(mint) && a.equals(NATIVE_MINT)))) {
    throw new Error('This pool does not pair this token with SOL.');
  }
}

async function quoteGraduated(
  connection: Connection,
  target: Extract<TradeTarget, { phase: 'graduated' }>,
  request: TradeRequest,
) {
  const { client, state } = await dammPool(connection, target.pool);
  assertDammPool(state, target.mint);
  const currentPoint = await getDammCurrentPoint(connection, state.activationType);
  const quote = client.getQuote2({
    inputTokenMint: inputMint(request.side, target.mint),
    // cp-amm applies `amount * (10000 - slippage) / 10000`, so slippage is in bps.
    slippage: request.slippageBps,
    currentPoint,
    poolState: state,
    tokenADecimal: decimalsOf(state.tokenAMint),
    tokenBDecimal: decimalsOf(state.tokenBMint),
    hasReferral: false,
    swapMode: DammSwapMode.ExactIn,
    amountIn: toBN(request.amountIn),
  });
  const amountOut = big(quote.outputAmount);
  // `priceImpact` is a percentage Decimal.
  const impactPct = Number(quote.priceImpact.toString());
  return {
    quote: {
      amountIn: request.amountIn,
      amountOut,
      minOut: quote.minimumAmountOut ? big(quote.minimumAmountOut) : amountOut,
      priceImpact: Number.isFinite(impactPct) ? Math.abs(impactPct) / 100 : null,
    } satisfies TradeQuote,
    client,
    state,
  };
}

export async function quoteTrade(
  connection: Connection,
  target: TradeTarget,
  request: TradeRequest,
): Promise<TradeQuote> {
  if (target.phase === 'curve') return quoteCurve(connection, target, request);
  return (await quoteGraduated(connection, target, request)).quote;
}

function signedMinOut(fresh: TradeQuote, shownMinOut: bigint): bigint {
  if (fresh.amountOut < shownMinOut) {
    throw new Error(
      'The price moved: this trade would now return less than the minimum you were shown. Check the new quote and try again.',
    );
  }
  return fresh.minOut > shownMinOut ? fresh.minOut : shownMinOut;
}

/**
 * Re-quotes against fresh pool state and signs with the higher of that
 * quote's minimum out and the one the user was shown, so the transaction
 * never carries a stale or looser bound.
 */
export async function buildTradeTransaction(
  connection: Connection,
  owner: PublicKey,
  target: TradeTarget,
  order: TradeOrder,
): Promise<Transaction> {
  if (target.phase === 'curve') {
    const quote = await quoteCurve(connection, target, order);
    return dbc(connection).pool.swap2({
      owner,
      payer: owner,
      pool: target.pool,
      swapBaseForQuote: order.side === 'sell',
      referralTokenAccount: null,
      swapMode: SwapMode.PartialFill,
      amountIn: toBN(quote.amountIn),
      minimumAmountOut: toBN(signedMinOut(quote, order.minOut)),
    });
  }

  const { quote, client, state } = await quoteGraduated(connection, target, order);
  const input = inputMint(order.side, target.mint);
  return client.swap2({
    payer: owner,
    pool: target.pool,
    inputTokenMint: input,
    outputTokenMint: input.equals(state.tokenAMint) ? state.tokenBMint : state.tokenAMint,
    tokenAMint: state.tokenAMint,
    tokenBMint: state.tokenBMint,
    tokenAProgram: getTokenProgram(state.tokenAFlag),
    tokenBProgram: getTokenProgram(state.tokenBFlag),
    tokenAVault: state.tokenAVault,
    tokenBVault: state.tokenBVault,
    referralTokenAccount: null,
    poolState: state,
    swapMode: DammSwapMode.ExactIn,
    amountIn: toBN(quote.amountIn),
    minimumAmountOut: toBN(signedMinOut(quote, order.minOut)),
  });
}
