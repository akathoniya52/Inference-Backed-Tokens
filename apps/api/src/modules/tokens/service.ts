import { Models, Types, type ModelFields } from '@ibt/db';
import {
  AppError,
  LaunchConfirmResponseSchema,
  isAppError,
  type LaunchConfirmRequest,
  type LaunchConfirmResponse,
  type LaunchPrepareRequest,
  type LaunchPrepareResponse,
} from '@ibt/shared';

import type { AppContext } from '../../app.js';
import type { AuthUser } from '../../context.js';
import { isDuplicateKey } from '../../lib/mongoErrors.js';
import { toPublicKey } from '../../lib/publicKey.js';

type ModelRow = ModelFields & { _id: Types.ObjectId };

const LAUNCHED = new Set(['curve', 'graduated']);

/**
 * 409 without a catalog code: `@ibt/shared` (outside this app) has no conflict
 * code for launches, so the router renders it as `token_already_launched`.
 */
export class LaunchConflictError extends Error {
  readonly code = 'token_already_launched';
}

const POOL_MISMATCH_MESSAGES: Record<string, string> = {
  pool_not_found: 'no DBC pool found for this mint',
  config: 'pool does not use the platform config',
  creator: 'pool creator is not the model owner',
  tx_failed: 'launch transaction failed',
};

async function ownedModel(user: AuthUser, modelId: string): Promise<ModelRow> {
  const row = await Models.findById(modelId).lean<ModelRow>();
  if (!row) throw new AppError('model_not_found');
  if (!row.providerId.equals(user.userId)) throw new AppError('forbidden');
  return row;
}

function confirmed(row: ModelRow): LaunchConfirmResponse {
  return LaunchConfirmResponseSchema.parse({
    token: {
      status: row.token.status,
      mint: row.token.mint,
      dbcPool: row.token.dbcPool,
      progress: row.token.status === 'graduated' ? 1 : 0,
    },
  });
}

/** Called before the wallet signs, so `/metadata/<mint>.json` resolves at once (P5-T3). */
export async function prepareLaunch(
  user: AuthUser,
  input: LaunchPrepareRequest,
): Promise<LaunchPrepareResponse> {
  const row = await ownedModel(user, input.modelId);
  if (LAUNCHED.has(row.token.status)) {
    throw new LaunchConflictError('model token is already launched');
  }
  try {
    const updated = await Models.findOneAndUpdate(
      { _id: row._id, 'token.status': { $in: ['none', 'pending'] } },
      {
        $set: {
          'token.status': 'pending',
          'token.mint': input.mint,
          'token.symbol': input.symbol ?? row.token.symbol ?? null,
        },
      },
      { new: true },
    ).lean<ModelRow>();
    if (!updated) throw new LaunchConflictError('model token is already launched');
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw new LaunchConflictError('mint is already used by another model', { cause: err });
    }
    throw err;
  }
  return { token: { status: 'pending', mint: input.mint } };
}

/**
 * `@ibt/chain` may load its own copy of `@ibt/shared`, so its `AppError` fails
 * `instanceof`; match on the shape instead.
 */
function poolMismatchReason(err: unknown): string | null {
  if (isAppError(err)) {
    if (err.code !== 'pool_mismatch') return null;
    return typeof err.details.reason === 'string' ? err.details.reason : 'unknown';
  }
  if (!(err instanceof Error) || !('code' in err) || err.code !== 'pool_mismatch') return null;
  const details = 'details' in err ? err.details : undefined;
  const reason =
    typeof details === 'object' && details !== null && 'reason' in details
      ? details.reason
      : undefined;
  return typeof reason === 'string' ? reason : 'unknown';
}

async function verifyPool(ctx: AppContext, user: AuthUser, input: LaunchConfirmRequest) {
  try {
    return await ctx.chain.verifyLaunch({
      signature: input.signature,
      mint: toPublicKey(input.mint),
      expectedConfig: toPublicKey(ctx.env.DBC_CONFIG),
      expectedCreator: toPublicKey(user.wallet),
    });
  } catch (err) {
    const reason = poolMismatchReason(err);
    if (reason === null) throw err;
    throw new AppError('pool_mismatch', {
      message: POOL_MISMATCH_MESSAGES[reason] ?? `pool check failed: ${reason}`,
      cause: err,
    });
  }
}

/** Verifies the DBC pool on-chain (L398, L524) and moves the token to `curve`. */
export async function confirmLaunch(
  ctx: AppContext,
  user: AuthUser,
  input: LaunchConfirmRequest,
): Promise<LaunchConfirmResponse> {
  const row = await ownedModel(user, input.modelId);
  if (LAUNCHED.has(row.token.status)) {
    if (row.token.mint === input.mint) return confirmed(row);
    throw new LaunchConflictError('model token is already launched with another mint');
  }
  if (row.token.status !== 'pending' || row.token.mint !== input.mint) {
    throw new AppError('pool_mismatch', { message: 'mint was not prepared for this model' });
  }

  const { pool } = await verifyPool(ctx, user, input);
  const updated = await Models.findOneAndUpdate(
    { _id: row._id, 'token.status': 'pending', 'token.mint': input.mint },
    {
      $set: {
        'token.status': 'curve',
        'token.dbcPool': pool,
        'token.launchSignature': input.signature,
      },
    },
    { new: true },
  ).lean<ModelRow>();
  if (updated) {
    ctx.logger.info({ modelId: input.modelId, mint: input.mint, pool }, 'token launched');
    return confirmed(updated);
  }

  // A concurrent confirm or re-prepare won the race.
  const current = await ownedModel(user, input.modelId);
  if (LAUNCHED.has(current.token.status) && current.token.mint === input.mint) {
    return confirmed(current);
  }
  throw new AppError('pool_mismatch', { message: 'mint was not prepared for this model' });
}
