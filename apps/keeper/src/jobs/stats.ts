import { Models, Requests, Settlements, withTransaction, type Types } from '@ibt/db';
import { toBigInt } from '@ibt/shared';

import type { KeeperCtx } from '../ctx.js';

/** Every 5 min. */
export const STATS_CRON = '15 */5 * * * *';
const DAY_MS = 86_400_000;

interface RequestRow {
  _id: Types.ObjectId;
  total: number;
  success: number;
  revenue: bigint | number;
}

interface LiquidityRow {
  _id: Types.ObjectId;
  lamports: bigint | number;
}

/**
 * Rolling 24 h `models.stats` (L308): `requests` counts every request, `successRate` the
 * share with status `success`, `revenueMicroUsdc` the cost of every billed request
 * (including streams captured after an early stop; released ones cost 0). `lockedLiquidityLamports`
 * sums `liquidity.solAddedLamports` over the model's `done` settlements (all time); the
 * api renders it as `lockedLiquiditySol`.
 */
export function createStatsJob(ctx: Pick<KeeperCtx, 'clock' | 'logger'>) {
  const log = ctx.logger.child({ job: 'stats' });
  return {
    async tick(): Promise<number> {
      const since = new Date(ctx.clock.now().getTime() - DAY_MS);
      const requests = await Requests.aggregate<RequestRow>([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: '$modelId',
            total: { $sum: 1 },
            success: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
            revenue: { $sum: '$costMicroUsdc' },
          },
        },
      ]);
      const liquidity = await Settlements.aggregate<LiquidityRow>([
        { $match: { state: 'done' } },
        { $group: { _id: '$modelId', lamports: { $sum: '$liquidity.solAddedLamports' } } },
      ]);
      const byModel = new Map(requests.map((row) => [row._id.toHexString(), row]));
      const locked = new Map(liquidity.map((row) => [row._id.toHexString(), row.lamports]));

      const models = await Models.find({}, { _id: 1 }).lean();
      const ops = models.map(({ _id }) => {
        const row = byModel.get(_id.toHexString());
        return {
          updateOne: {
            filter: { _id },
            update: {
              $set: {
                'stats.requests': row?.total ?? 0,
                'stats.successRate': row && row.total > 0 ? row.success / row.total : 0,
                'stats.revenueMicroUsdc': toBigInt(row?.revenue ?? 0n),
                'stats.lockedLiquidityLamports': toBigInt(locked.get(_id.toHexString()) ?? 0n),
              },
            },
          },
        };
      });
      if (ops.length > 0) {
        await withTransaction((session) => Models.bulkWrite(ops, { session }));
      }
      log.debug({ models: ops.length }, 'model stats updated');
      return ops.length;
    },
  };
}
