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
 * L186/L241: 10% off a model for wallets holding at least 1,000,000 of its
 * tokens. Balances are cached per `wallet:mint` for 5 minutes; a failed read
 * means no discount for this call and is not cached.
 */
export function createHolderDiscount(ctx: AppContext): HolderDiscount {
  const cache = new Map<string, CachedBalance>();

  async function balanceOf(wallet: string, mint: string): Promise<bigint> {
    const cacheKey = `${wallet}:${mint}`;
    const now = ctx.clock().getTime();
    const cached = cache.get(cacheKey);
    if (cached && now - cached.readAt <= HOLDER_BALANCE_CACHE_MS) return cached.balance;
    const balance = await ctx.chain.tokenBalance(toPublicKey(wallet), toPublicKey(mint));
    for (const [key, entry] of cache) {
      if (now - entry.readAt > HOLDER_BALANCE_CACHE_MS) cache.delete(key);
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
