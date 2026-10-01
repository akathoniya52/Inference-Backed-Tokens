import {
  BPS_DENOMINATOR,
  DEFAULT_MAX_TOKENS,
  HOLDER_DISCOUNT_BPS,
  HOLDER_MIN_BASE_UNITS,
  TOKENS_PER_MTOK,
} from './constants.js';
import { ceilDiv, toNonNegativeBigInt, type IntLike } from './money.js';

export interface CostInput {
  /** Prompt tokens. */
  pt: IntLike;
  /** Completion tokens. */
  ct: IntLike;
  /** Input price, micro-USDC per million tokens. */
  inPrice: IntLike;
  /** Output price, micro-USDC per million tokens. */
  outPrice: IntLike;
}

/** G16: `ceil((pt·inPrice + ct·outPrice) / 1e6)` micro-USDC, before any discount. */
export function computeCostMicro({ pt, ct, inPrice, outPrice }: CostInput): bigint {
  const gross =
    toNonNegativeBigInt(pt, 'pt') * toNonNegativeBigInt(inPrice, 'inPrice') +
    toNonNegativeBigInt(ct, 'ct') * toNonNegativeBigInt(outPrice, 'outPrice');
  return ceilDiv(gross, TOKENS_PER_MTOK);
}

export interface HoldEstimateInput {
  promptTokens: IntLike;
  /** Requested `max_tokens`; defaults to DEFAULT_MAX_TOKENS (L236). */
  maxTokens?: IntLike;
  inPrice: IntLike;
  outPrice: IntLike;
}

/** Hold for the worst case: every allowed completion token is produced, at gross price. */
export function estimateHoldMicro({
  promptTokens,
  maxTokens = DEFAULT_MAX_TOKENS,
  inPrice,
  outPrice,
}: HoldEstimateInput): bigint {
  return computeCostMicro({ pt: promptTokens, ct: maxTokens, inPrice, outPrice });
}

export function assertBps(bps: number, name = 'bps'): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS_DENOMINATOR) {
    throw new RangeError(`${name} must be an integer in [0, ${BPS_DENOMINATOR}], got ${bps}`);
  }
}

/** G16: `floor(cost·(10000−bps)/10000)`. */
export function applyDiscount(costMicro: bigint, discountBps: number): bigint {
  assertBps(discountBps, 'discountBps');
  const cost = toNonNegativeBigInt(costMicro, 'costMicro');
  return (cost * BigInt(BPS_DENOMINATOR - discountBps)) / BigInt(BPS_DENOMINATOR);
}

export function holderDiscountBps(balanceBaseUnits: IntLike): number {
  return toNonNegativeBigInt(balanceBaseUnits, 'balanceBaseUnits') >= HOLDER_MIN_BASE_UNITS
    ? HOLDER_DISCOUNT_BPS
    : 0;
}
