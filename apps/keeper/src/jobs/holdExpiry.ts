import { capture, expireHolds, findDueCaptures } from '@ibt/db';

import type { KeeperCtx } from '../ctx.js';

/** Every 60 s. */
export const HOLD_EXPIRY_CRON = '30 * * * * *';

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/**
 * Closes open holds past `expiresAt` (G15); returns how many. A hold carrying a
 * due capture (GW-12: delivered, but the gateway could not bill it) is captured
 * for that cost instead of released; a failed capture is alerted and retried on
 * the next run.
 */
export function createHoldExpiryJob(ctx: Pick<KeeperCtx, 'clock' | 'logger' | 'alerter'>) {
  const log = ctx.logger.child({ job: 'holdExpiry' });
  return {
    async tick(): Promise<number> {
      const now = ctx.clock.now();
      let captured = 0;
      for (const due of await findDueCaptures(now)) {
        const holdId = due.holdId.toHexString();
        try {
          // Idempotent, and refused above the hold, so a rerun never bills twice.
          const { alreadyCaptured } = await capture(due.holdId, due.costMicro, due.request);
          if (!alreadyCaptured) captured += 1;
        } catch (err) {
          log.error({ holdId, errName: errName(err) }, 'due capture failed; retried next run');
          await ctx.alerter
            .alert('error', 'due capture of an expired hold failed', {
              holdId,
              requestId: due.request.requestId,
              costMicro: due.costMicro.toString(),
            })
            .catch((alertErr: unknown) => {
              log.error({ errName: errName(alertErr) }, 'alert failed');
            });
        }
      }
      if (captured > 0) log.info({ captured }, 'captured due holds');
      const expired = await expireHolds(now);
      if (expired > 0) log.info({ expired }, 'expired stale holds');
      return captured + expired;
    },
  };
}
