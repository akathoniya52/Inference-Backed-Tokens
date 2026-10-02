import { Models, Requests, type Types } from '@ibt/db';
import { lamportsToSol, microToUsdcString, splitRevenue, toBigInt } from '@ibt/shared';

import type { KeeperCtx } from '../ctx.js';
import { tokenPhase } from '../settlement/steps.js';

/** Every 5 min (L251). */
export const FLOAT_MONITOR_CRON = '0 */5 * * * *';

export interface FloatReport {
  keeperLamports: bigint;
  treasuryMicroUsdc: bigint;
  expectedPayoutMicroUsdc: bigint;
  alerts: string[];
}

export interface FloatMonitor {
  tick(): Promise<FloatReport>;
}

/**
 * The next run's payouts: per model, the provider share of unsettled billable revenue
 * plus its carry-over, counted only when it reaches the minimum and capped per run (G18).
 */
export async function expectedPayoutMicro(ctx: Pick<KeeperCtx, 'config'>): Promise<bigint> {
  const pending = await Requests.aggregate<{ _id: Types.ObjectId; total: bigint | number }>([
    { $match: { status: 'success', settlementId: null } },
    { $group: { _id: '$modelId', total: { $sum: '$costMicroUsdc' } } },
  ]);
  const revenue = new Map(pending.map((row) => [row._id.toHexString(), toBigInt(row.total)]));
  const models = await Models.find(
    { status: { $ne: 'delisted' } },
    { splits: 1, 'token.status': 1, 'token.carryOverMicroUsdc': 1 },
  ).lean();
  const { minPayoutMicroUsdc, maxPayoutMicroUsdc } = ctx.config;
  let expected = 0n;
  for (const model of models) {
    const rev = revenue.get(model._id.toHexString()) ?? 0n;
    const share = splitRevenue(rev, model.splits, tokenPhase(model.token.status)).providerMicro;
    const accrued = share + model.token.carryOverMicroUsdc;
    if (accrued < minPayoutMicroUsdc) continue;
    expected += accrued > maxPayoutMicroUsdc ? maxPayoutMicroUsdc : accrued;
  }
  return expected;
}

/** Alerts when the keeper SOL float is below `FLOAT_MIN_SOL` or the treasury cannot cover the next payouts (L251, L530). */
export function createFloatMonitor(
  ctx: Pick<KeeperCtx, 'chain' | 'logger' | 'alerter' | 'keeper' | 'treasury' | 'config'>,
  opts: { floatMinLamports: bigint },
): FloatMonitor {
  const log = ctx.logger.child({ job: 'floatMonitor' });
  return {
    async tick() {
      const keeperLamports = await ctx.chain.solBalance(ctx.keeper.publicKey);
      const treasuryMicroUsdc = await ctx.chain.usdcBalance(ctx.treasury.publicKey);
      const expectedPayoutMicroUsdc = await expectedPayoutMicro(ctx);
      const alerts: string[] = [];

      if (keeperLamports < opts.floatMinLamports) {
        alerts.push('keeper float below FLOAT_MIN_SOL');
        await ctx.alerter.alert('warn', 'keeper float below FLOAT_MIN_SOL', {
          keeper: ctx.keeper.publicKey.toBase58(),
          balanceSol: lamportsToSol(keeperLamports),
          minSol: lamportsToSol(opts.floatMinLamports),
        });
      }
      if (treasuryMicroUsdc < expectedPayoutMicroUsdc) {
        alerts.push('treasury USDC below next expected payout');
        await ctx.alerter.alert('warn', 'treasury USDC below next expected payout', {
          treasury: ctx.treasury.publicKey.toBase58(),
          balanceUsdc: microToUsdcString(treasuryMicroUsdc),
          expectedPayoutUsdc: microToUsdcString(expectedPayoutMicroUsdc),
        });
      }
      log.debug(
        {
          keeperSol: lamportsToSol(keeperLamports),
          treasuryUsdc: microToUsdcString(treasuryMicroUsdc),
          expectedPayoutUsdc: microToUsdcString(expectedPayoutMicroUsdc),
        },
        'float checked',
      );
      return { keeperLamports, treasuryMicroUsdc, expectedPayoutMicroUsdc, alerts };
    },
  };
}
