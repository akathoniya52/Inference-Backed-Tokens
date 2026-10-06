import { Models, Requests, Settlements, Types, type ModelFields } from '@ibt/db';
import {
  AppError,
  FloatResponseSchema,
  HealthChecksRunResponseSchema,
  ModelPauseResponseSchema,
  SettlementRetryResponseSchema,
  lamportsToSol,
  microToUsdcString,
  solToLamports,
  splitRevenue,
  type FloatResponse,
  type HealthChecksRunResponse,
  type ModelPauseResponse,
  type SettlementRetryResponse,
  type TokenPhase,
} from '@ibt/shared';

import type { AppContext } from '../../app.js';
import { toPublicKey } from '../../lib/publicKey.js';
import { runHealthCheck, type HealthCheckModel } from '../models/health.js';

/** `failed` → resume from `lastCompletedState` (L182); the keeper picks it up on its next pass. */
export async function retrySettlement(
  ctx: AppContext,
  id: string,
): Promise<SettlementRetryResponse> {
  const row = await Settlements.findById(id).lean();
  if (!row) throw new AppError('not_found', { message: 'settlement not found' });
  if (row.state !== 'failed') throw new AppError('settlement_not_retryable');

  const state = row.lastCompletedState ?? 'computing';
  const updated = await Settlements.updateOne(
    { _id: row._id, state: 'failed' },
    { $set: { state, attempts: 0, error: null } },
  );
  if (updated.modifiedCount !== 1) throw new AppError('settlement_not_retryable');
  ctx.logger.info({ settlementId: id, state }, 'admin: settlement retry');
  return SettlementRetryResponseSchema.parse({ id, state });
}

export interface PauseResult {
  response: ModelPauseResponse;
  /** True when this call moved the model from `active` to `paused`. */
  changed: boolean;
  slug: string;
}

export async function pauseModel(ctx: AppContext, id: string): Promise<PauseResult> {
  const row = await Models.findById(id).select({ status: 1, slug: 1 }).lean();
  if (!row) throw new AppError('model_not_found');
  if (row.status === 'delisted') {
    throw new AppError('invalid_request', { message: 'delisted models cannot be paused' });
  }
  // An owner (or health) pause is taken over too, so the owner cannot lift it (API-02);
  // never a delisted model (API-03).
  const before = await Models.findOneAndUpdate(
    { _id: row._id, status: { $in: ['active', 'paused'] }, pausedBy: { $ne: 'admin' } },
    { $set: { status: 'paused', pausedBy: 'admin' } },
  )
    .select({ status: 1 })
    .lean();
  if (!before) {
    const current = await Models.findById(row._id).select({ status: 1 }).lean();
    if (current?.status === 'delisted') {
      throw new AppError('invalid_request', { message: 'delisted models cannot be paused' });
    }
  }
  const changed = before?.status === 'active';
  if (changed) {
    ctx.logger.info({ modelId: id }, 'admin: model paused');
    ctx.alerts.modelPaused({ modelId: id, slug: row.slug, reason: 'admin' });
  }
  return {
    response: ModelPauseResponseSchema.parse({ id, status: 'paused' }),
    changed,
    slug: row.slug,
  };
}

type SplitModel = Pick<ModelFields, 'splits' | 'token'> & { _id: Types.ObjectId };

function phaseOf(status: ModelFields['token']['status']): TokenPhase {
  return status === 'curve' || status === 'graduated' ? status : 'none';
}

/**
 * Provider share of all billable requests not yet tagged by a settlement:
 * what the next settlement runs will pay out of the treasury (70%, or 90%
 * before a token exists, G17).
 */
export async function nextExpectedPayoutMicro(): Promise<bigint> {
  const sums = await Requests.aggregate<{ _id: Types.ObjectId; revenue: bigint | number }>([
    { $match: { settlementId: null, costMicroUsdc: { $gt: 0 } } },
    { $group: { _id: '$modelId', revenue: { $sum: '$costMicroUsdc' } } },
  ]);
  if (sums.length === 0) return 0n;
  const models = await Models.find({ _id: { $in: sums.map((row) => row._id) } })
    .select({ splits: 1, token: 1 })
    .lean<SplitModel[]>();
  const byId = new Map(models.map((model) => [model._id.toHexString(), model]));
  return sums.reduce((total, row) => {
    const model = byId.get(row._id.toHexString());
    if (!model) return total;
    const split = splitRevenue(BigInt(row.revenue), model.splits, phaseOf(model.token.status));
    return total + split.providerMicro;
  }, 0n);
}

/** `GET /api/admin/float` (L530): keeper SOL vs `FLOAT_MIN_SOL`, treasury USDC vs next payout. */
export async function floatStatus(ctx: AppContext): Promise<FloatResponse> {
  const minLamports = solToLamports(ctx.env.FLOAT_MIN_SOL);
  const [lamports, usdcMicro, nextPayoutMicro] = await Promise.all([
    ctx.chain.solBalance(toPublicKey(ctx.env.KEEPER_WALLET)),
    ctx.chain.usdcBalance(toPublicKey(ctx.env.TREASURY_WALLET)),
    nextExpectedPayoutMicro(),
  ]);
  return FloatResponseSchema.parse({
    keeper: {
      wallet: ctx.env.KEEPER_WALLET,
      sol: lamportsToSol(lamports),
      minSol: lamportsToSol(minLamports),
      belowMin: lamports < minLamports,
    },
    treasury: {
      wallet: ctx.env.TREASURY_WALLET,
      usdc: microToUsdcString(usdcMicro),
      nextExpectedPayoutUsdc: microToUsdcString(nextPayoutMicro),
      belowNextPayout: usdcMicro < nextPayoutMicro,
    },
  });
}

/** Upstream probes in flight at once during `runAllHealthChecks`. */
export const HEALTH_CHECK_CONCURRENCY = 4;

/** G12: one health check per active model; the keeper calls this every 60 s. */
export async function runAllHealthChecks(ctx: AppContext): Promise<HealthChecksRunResponse> {
  const models = await Models.find({ status: 'active' })
    .select({ slug: 1, upstream: 1, status: 1 })
    .lean<HealthCheckModel[]>();
  const queue = [...models];
  const results: Awaited<ReturnType<typeof runHealthCheck>>[] = [];
  const worker = async (): Promise<void> => {
    for (let model = queue.shift(); model !== undefined; model = queue.shift()) {
      results.push(await runHealthCheck(ctx, model));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HEALTH_CHECK_CONCURRENCY, queue.length) }, worker),
  );
  return HealthChecksRunResponseSchema.parse({
    checked: results.length,
    ok: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    paused: results.filter((result) => result.status === 'paused').length,
  });
}
