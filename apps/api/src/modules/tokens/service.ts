import type { LaunchMismatchReason } from '@ibt/chain';
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
import { fallbackSymbol } from '../metadata/router.js';

type ModelRow = ModelFields & { _id: Types.ObjectId };

const LAUNCHED = new Set(['curve', 'graduated']);

/**
 * 409 without a catalog code: `@ibt/shared` (outside this app) has no conflict
 * code for launches, so the router renders it as `token_already_launched`.
 */
export class LaunchConflictError extends Error {
  readonly code = 'token_already_launched';
}

const POOL_MISMATCH_MESSAGES: Record<LaunchMismatchReason, string> = {
  tx_not_found: 'launch transaction not found at confirmed commitment yet; retry shortly',
  tx_failed: 'launch transaction failed',
  tx_not_launch: 'transaction does not create the DBC pool for this mint',
  pool_not_found: 'no DBC pool found for this mint',
  config: 'pool does not use the platform config',
  creator: 'pool creator is not the model owner',
  metadata_not_found: 'token has no metadata',
  metadata_name: 'token name does not match the model name',
  metadata_symbol: 'token symbol does not match the prepared symbol',
  metadata_uri: "token metadata URI is not this platform's metadata URL",
};

function isMismatchReason(reason: string): reason is LaunchMismatchReason {
  return Object.hasOwn(POOL_MISMATCH_MESSAGES, reason);
}

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

/** True when the platform-config DBC pool for `mint` exists and was created by `wallet`. */
async function hasOwnPool(ctx: AppContext, mint: string, wallet: string): Promise<boolean> {
  const pool = await ctx.chain.readPool({
    mint: toPublicKey(mint),
    config: toPublicKey(ctx.env.DBC_CONFIG),
  });
  return pool !== null && pool.creator === wallet && pool.config === ctx.env.DBC_CONFIG;
}

/**
 * Called before the wallet signs, so `/metadata/<mint>.json` resolves at once (P5-T3).
 * API-07: only an active model launches, and once the pending mint has a pool on
 * chain neither the mint nor its symbol may change: that pool is what confirm lists.
 */
export async function prepareLaunch(
  ctx: AppContext,
  user: AuthUser,
  input: LaunchPrepareRequest,
): Promise<LaunchPrepareResponse> {
  const row = await ownedModel(user, input.modelId);
  if (LAUNCHED.has(row.token.status)) {
    throw new LaunchConflictError('model token is already launched');
  }
  if (row.status !== 'active') {
    throw new AppError('forbidden', { message: 'only an active model can launch its token' });
  }
  const symbol = input.symbol ?? row.token.symbol ?? null;
  const pendingMint = row.token.status === 'pending' ? (row.token.mint ?? null) : null;
  if (pendingMint !== null && (await hasOwnPool(ctx, pendingMint, user.wallet))) {
    if (pendingMint === input.mint && symbol === (row.token.symbol ?? null)) {
      return prepared(ctx, pendingMint);
    }
    throw new LaunchConflictError(
      'a pool already exists for the prepared mint; confirm that launch instead',
    );
  }
  try {
    // Conditional on the state checked above, so a concurrent prepare or confirm wins cleanly.
    const updated = await Models.findOneAndUpdate(
      {
        _id: row._id,
        status: 'active',
        'token.status': row.token.status,
        'token.mint': row.token.mint ?? null,
      },
      { $set: { 'token.status': 'pending', 'token.mint': input.mint, 'token.symbol': symbol } },
      { new: true },
    ).lean<ModelRow>();
    if (!updated) throw new LaunchConflictError('model launch state changed meanwhile; retry');
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw new LaunchConflictError('mint is already used by another model', { cause: err });
    }
    throw err;
  }
  return prepared(ctx, input.mint);
}

/** API-06: the metadata URI confirm requires on chain, unless `API_PUBLIC_URL` is unset. */
function metadataUriOf(ctx: AppContext, mint: string): string | undefined {
  return ctx.env.API_PUBLIC_URL === undefined
    ? undefined
    : `${ctx.env.API_PUBLIC_URL}/metadata/${mint}.json`;
}

/** The web builds `createPool` with this `metadataUri`, so confirm can never mismatch it. */
function prepared(ctx: AppContext, mint: string): LaunchPrepareResponse {
  const uri = metadataUriOf(ctx, mint);
  return { token: { status: 'pending', mint }, ...(uri === undefined ? {} : { metadataUri: uri }) };
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

/**
 * API-06: the token must carry this platform's metadata URI, the prepared symbol
 * and the model name, exactly as the web launch flow writes them.
 */
function expectedMetadata(ctx: AppContext, row: ModelRow, mint: string) {
  const uri = metadataUriOf(ctx, mint);
  return {
    name: row.name,
    symbol: row.token.symbol ?? fallbackSymbol(row.slug),
    ...(uri === undefined ? {} : { uri }),
  };
}

async function verifyPool(
  ctx: AppContext,
  user: AuthUser,
  row: ModelRow,
  input: LaunchConfirmRequest,
) {
  try {
    return await ctx.chain.verifyLaunch({
      signature: input.signature,
      mint: toPublicKey(input.mint),
      expectedConfig: toPublicKey(ctx.env.DBC_CONFIG),
      expectedCreator: toPublicKey(user.wallet),
      expectedMetadata: expectedMetadata(ctx, row, input.mint),
    });
  } catch (err) {
    const reason = poolMismatchReason(err);
    if (reason === null) throw err;
    throw new AppError('pool_mismatch', {
      message: isMismatchReason(reason)
        ? POOL_MISMATCH_MESSAGES[reason]
        : `pool check failed: ${reason}`,
      details: { reason },
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
  if (row.token.status !== 'pending') {
    throw new AppError('pool_mismatch', { message: 'mint was not prepared for this model' });
  }

  // A pending model may confirm another mint than the prepared one when the chain
  // shows a valid launch of it (e.g. the mint of an earlier prepare whose confirm
  // failed): refusing would orphan a paid pool. The chain check decides either way.
  const { pool } = await verifyPool(ctx, user, row, input);
  let updated: ModelRow | null;
  try {
    updated = await Models.findOneAndUpdate(
      { _id: row._id, 'token.status': 'pending', 'token.mint': row.token.mint ?? null },
      {
        $set: {
          'token.status': 'curve',
          'token.mint': input.mint,
          'token.dbcPool': pool,
          'token.launchSignature': input.signature,
        },
      },
      { new: true },
    ).lean<ModelRow>();
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw new LaunchConflictError('mint is already used by another model', { cause: err });
    }
    throw err;
  }
  if (updated) {
    ctx.logger.info({ modelId: input.modelId, mint: input.mint, pool }, 'token launched');
    return confirmed(updated);
  }

  // A concurrent confirm or re-prepare won the race.
  const current = await ownedModel(user, input.modelId);
  if (LAUNCHED.has(current.token.status)) {
    if (current.token.mint === input.mint) return confirmed(current);
    throw new LaunchConflictError('model token is already launched with another mint');
  }
  throw new LaunchConflictError('model launch state changed meanwhile; retry');
}
