import { BPS_DENOMINATOR, LAMPORTS_PER_SOL, type SplitsBps } from './constants.js';
import { toNonNegativeBigInt, type IntLike } from './money.js';
import { assertBps } from './pricing.js';

export const TOKEN_PHASES = ['none', 'curve', 'graduated'] as const;
export type TokenPhase = (typeof TOKEN_PHASES)[number];

export interface RevenueSplit {
  providerMicro: bigint;
  liquidityMicro: bigint;
  platformMicro: bigint;
}

export function assertSplits(splits: SplitsBps): void {
  assertBps(splits.providerBps, 'providerBps');
  assertBps(splits.liquidityBps, 'liquidityBps');
  assertBps(splits.platformBps, 'platformBps');
  const total = splits.providerBps + splits.liquidityBps + splits.platformBps;
  if (total !== BPS_DENOMINATOR) {
    throw new RangeError(`splits must sum to ${BPS_DENOMINATOR} bps, got ${total}`);
  }
}

/**
 * G16/G17: provider and liquidity shares are floored, the platform takes the
 * remainder so `provider + liquidity + platform === revenue` always holds. With
 * no token (`phase: 'none'`) the liquidity share is folded into the provider.
 */
export function splitRevenue(
  revenueMicro: IntLike,
  splits: SplitsBps,
  phase: TokenPhase,
): RevenueSplit {
  assertSplits(splits);
  const revenue = toNonNegativeBigInt(revenueMicro, 'revenueMicro');
  const denominator = BigInt(BPS_DENOMINATOR);
  const providerBps =
    phase === 'none' ? splits.providerBps + splits.liquidityBps : splits.providerBps;
  const liquidityBps = phase === 'none' ? 0 : splits.liquidityBps;

  const providerMicro = (revenue * BigInt(providerBps)) / denominator;
  const liquidityMicro = (revenue * BigInt(liquidityBps)) / denominator;
  return {
    providerMicro,
    liquidityMicro,
    platformMicro: revenue - providerMicro - liquidityMicro,
  };
}

/** Lamports bought by a micro-USDC slice at `solPriceMicroUsdc` per SOL, floored. */
export function sliceToLamports(sliceMicro: IntLike, solPriceMicroUsdc: IntLike): bigint {
  const slice = toNonNegativeBigInt(sliceMicro, 'sliceMicro');
  const price = toNonNegativeBigInt(solPriceMicroUsdc, 'solPriceMicroUsdc');
  if (price === 0n) throw new RangeError('solPriceMicroUsdc must be > 0');
  return (slice * LAMPORTS_PER_SOL) / price;
}
