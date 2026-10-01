import { expireHolds } from '@ibt/db';

import type { KeeperCtx } from '../ctx.js';

/** Every 60 s. */
export const HOLD_EXPIRY_CRON = '30 * * * * *';

/** Releases open holds past `expiresAt` (G15); returns how many expired. */
export function createHoldExpiryJob(ctx: Pick<KeeperCtx, 'clock' | 'logger'>) {
  const log = ctx.logger.child({ job: 'holdExpiry' });
  return {
    async tick(): Promise<number> {
      const expired = await expireHolds(ctx.clock.now());
      if (expired > 0) log.info({ expired }, 'expired stale holds');
      return expired;
    },
  };
}
