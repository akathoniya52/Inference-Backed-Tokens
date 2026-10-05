import { RPC_BACKOFF_MS } from '@ibt/chain';
import { Settlements, type SettlementDoc } from '@ibt/db';
import { AppError } from '@ibt/shared';

import type { KeeperCtx } from '../ctx.js';
import {
  LeaseLostError,
  SettlementConflictError,
  asConflict,
  claimSettlement,
  fence,
} from './fence.js';
import { PendingTxUnknownError, PendingTxUnresolvedError } from './pendingTx.js';
import {
  NonRetryableSettlementError,
  SETTLEMENT_STEPS,
  SolPriceRejectedError,
  hasCompleted,
  type NamedStep,
} from './steps.js';

export interface EngineOptions {
  steps?: readonly NamedStep[];
  /** Attempts per step before the settlement fails (L182). */
  attempts?: number;
  /** Wait before retry `n` (the last value repeats). */
  backoffMs?: readonly number[];
}

export const STEP_ATTEMPTS = 3;

const TRANSIENT_MESSAGE =
  /blockhash|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network|429|50[234]|rpc|changed mid-run/i;

/** RPC, blockhash, send and Mongo transaction errors are retried; anything else fails at once. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableSettlementError) return false;
  if (err instanceof PendingTxUnresolvedError || err instanceof PendingTxUnknownError) return true;
  if (err instanceof SolPriceRejectedError) return true;
  if (err instanceof AppError) return err.code === 'chain_send_failed' || err.retryable;
  if (typeof err !== 'object' || err === null) return false;
  if ('errorLabelSet' in err && err.errorLabelSet instanceof Set) {
    if (err.errorLabelSet.has('TransientTransactionError')) return true;
  }
  if ('code' in err && err.code === 112) return true;
  return err instanceof Error && TRANSIENT_MESSAGE.test(err.message);
}

/** Includes the cause chain: `chain_send_failed` alone hides the program error behind it. */
const errorMessage = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${errorMessage(err.cause)}` : err.message;
};

async function reload(settlement: SettlementDoc): Promise<SettlementDoc> {
  const fresh = await Settlements.findById(settlement._id);
  if (!fresh) throw new Error(`settlement ${settlement._id.toHexString()} vanished`);
  return fence(fresh);
}

/** `updateOne` on `settlement` that only writes while its lease epoch is unchanged. */
async function updateFenced(settlement: SettlementDoc, update: object): Promise<void> {
  const { matchedCount } = await Settlements.updateOne(
    { _id: settlement._id, leaseEpoch: settlement.leaseEpoch ?? null },
    update,
  );
  if (matchedCount !== 1) {
    throw new SettlementConflictError('settlement was claimed by a newer lease epoch');
  }
}

async function fail(
  ctx: KeeperCtx,
  settlement: SettlementDoc,
  step: string,
  err: unknown,
): Promise<SettlementDoc> {
  const id = settlement._id.toHexString();
  await updateFenced(settlement, {
    $set: { state: 'failed', error: `${step}: ${errorMessage(err)}` },
  });
  const failed = await reload(settlement);
  ctx.logger.error({ err, settlement: id, step, attempts: failed.attempts }, 'settlement failed');
  await ctx.alerter.alert('error', 'settlement failed', {
    settlementId: id,
    modelId: failed.modelId.toHexString(),
    periodStart: failed.periodStart.toISOString(),
    step,
    lastCompletedState: failed.lastCompletedState,
    attempts: failed.attempts,
    error: failed.error,
  });
  return failed;
}

/**
 * Drives one settlement from `lastCompletedState` to `done` (L172, L182). Each step runs
 * up to `attempts` times with backoff on retryable errors; every failed attempt bumps
 * `attempts` and records `error`, and the doc is reloaded so an aborted transaction never
 * leaves stale in-memory state. Exhausted or non-retryable → `failed` plus an alert.
 * Steps are idempotent, so the `pendingTx` resume (G20) handles any send in flight.
 *
 * The settlement is first claimed for the run's lease epoch, and every write is fenced to
 * it (E2). When another runner changed it, this one leaves it alone without writing; when
 * the lease is lost, `LeaseLostError` propagates and stops the run.
 */
export async function runSettlement(
  ctx: KeeperCtx,
  start: SettlementDoc,
  opts: EngineOptions = {},
): Promise<SettlementDoc> {
  if (start.state === 'failed') return start;
  let settlement = start;
  try {
    settlement = await claimSettlement(ctx, start);
    if (settlement.state === 'failed') return settlement;
    return await runSteps(ctx, settlement, opts);
  } catch (err) {
    const conflict = asConflict(err);
    if (!conflict || conflict instanceof LeaseLostError) throw conflict ?? err;
    ctx.logger.warn(
      { err: conflict, settlement: settlement._id.toHexString() },
      'settlement changed under this runner; leaving it to the other',
    );
    return reload(settlement);
  }
}

async function runSteps(
  ctx: KeeperCtx,
  claimed: SettlementDoc,
  opts: EngineOptions,
): Promise<SettlementDoc> {
  const steps = opts.steps ?? SETTLEMENT_STEPS;
  const maxAttempts = opts.attempts ?? STEP_ATTEMPTS;
  const backoff = opts.backoffMs ?? RPC_BACKOFF_MS;
  let settlement = claimed;

  for (const step of steps) {
    for (let attempt = 1; ; attempt += 1) {
      if (hasCompleted(settlement, 'done')) return settlement;
      try {
        await step.run(ctx, settlement);
        break;
      } catch (err) {
        if (asConflict(err)) throw err;
        await updateFenced(settlement, {
          $inc: { attempts: 1 },
          $set: { error: `${step.name}: ${errorMessage(err)}` },
        });
        settlement = await reload(settlement);
        if (!isRetryable(err) || attempt >= maxAttempts) {
          return fail(ctx, settlement, step.name, err);
        }
        ctx.logger.warn(
          { err, settlement: settlement._id.toHexString(), step: step.name, attempt },
          'settlement step failed; retrying',
        );
        await ctx.sleep(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0);
      }
    }
  }
  return settlement;
}
