import { HOLDER_BALANCE_CACHE_MS, holderDiscountBps } from '@ibt/shared';

import type { AppContext } from '../../app.js';
import { toPublicKey } from '../../lib/publicKey.js';
import type { ResolvedModel } from './router.js';

export interface HolderDiscount {
  bpsFor(wallet: string, model: ResolvedModel): Promise<number>;
}

interface CachedBalance {
  balance: bigint;
  readAt: number;
}

/**
 * GW-09: a balance that grants the discount is trusted this long only. Moving
 * the tokens to another wallet discounts that wallet at once, so this bounds
 * the time both wallets can be discounted for the same tokens to 30 seconds
 * (it was 5 minutes). A balance below the threshold grants nothing, so it keeps
 * the long `HOLDER_BALANCE_CACHE_MS`.
 */
export const HOLDER_DISCOUNT_CACHE_MS = 30_000;
/** Cached `wallet:mint` balances at most; the oldest reads are evicted first. */
export const HOLDER_CACHE_MAX = 10_000;

function ttlOf(balance: bigint): number {
  return holderDiscountBps(balance) > 0 ? HOLDER_DISCOUNT_CACHE_MS : HOLDER_BALANCE_CACHE_MS;
}

/**
 * L186/L241: 10% off a model for wallets holding at least 1,000,000 of its
 * tokens. Balances are cached per `wallet:mint` (see `ttlOf`); a failed read
 * means no discount for this call and is not cached.
 */
export function createHolderDiscount(ctx: AppContext): HolderDiscount {
  const cache = new Map<string, CachedBalance>();
  const fresh = (entry: CachedBalance, now: number): boolean =>
    now >= entry.readAt && now - entry.readAt <= ttlOf(entry.balance);

  async function balanceOf(wallet: string, mint: string): Promise<bigint> {
    const cacheKey = `${wallet}:${mint}`;
    const now = ctx.clock().getTime();
    const cached = cache.get(cacheKey);
    if (cached && fresh(cached, now)) return cached.balance;
    const balance = await ctx.chain.tokenBalance(toPublicKey(wallet), toPublicKey(mint));
    cache.delete(cacheKey);
    for (const [key, entry] of cache) {
      if (!fresh(entry, now)) cache.delete(key);
    }
    for (const key of cache.keys()) {
      if (cache.size < HOLDER_CACHE_MAX) break;
      cache.delete(key);
    }
    cache.set(cacheKey, { balance, readAt: now });
    return balance;
  }

  return {
    async bpsFor(wallet, model) {
      const { status, mint } = model.token;
      if ((status !== 'curve' && status !== 'graduated') || !mint) return 0;
      try {
        return holderDiscountBps(await balanceOf(wallet, mint));
      } catch (err) {
        ctx.logger.warn(
          {
            modelId: model._id.toHexString(),
            mint,
            errName: err instanceof Error ? err.name : 'unknown',
          },
          'holder balance read failed; no discount',
        );
        return 0;
      }
    },
  };
}
