import { RPC_BACKOFF_MS } from '@ibt/chain';
import { Settlements, type SettlementDoc } from '@ibt/db';
import { AppError } from '@ibt/shared';

import type { KeeperCtx } from '../ctx.js';
import { PendingTxUnresolvedError } from './pendingTx.js';
import {
  NonRetryableSettlementError,
  SETTLEMENT_STEPS,
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
  if (err instanceof PendingTxUnresolvedError) return true;
  if (err instanceof AppError) return err.code === 'chain_send_failed' || err.retryable;
  if (typeof err !== 'object' || err === null) return false;
  if ('errorLabelSet' in err && err.errorLabelSet instanceof Set) {
    if (err.errorLabelSet.has('TransientTransactionError')) return true;
  }
  if ('code' in err && err.code === 112) return true;
  return err instanceof Error && TRANSIENT_MESSAGE.test(err.message);
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function reload(settlement: SettlementDoc): Promise<SettlementDoc> {
  const fresh = await Settlements.findById(settlement._id);
  if (!fresh) throw new Error(`settlement ${settlement._id.toHexString()} vanished`);
  return fresh;
}

async function fail(
  ctx: KeeperCtx,
  settlement: SettlementDoc,
  step: string,
  err: unknown,
): Promise<SettlementDoc> {
  const id = settlement._id.toHexString();
  await Settlements.updateOne(
    { _id: settlement._id },
    { $set: { state: 'failed', error: `${step}: ${errorMessage(err)}` } },
  );
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
 */
export async function runSettlement(
  ctx: KeeperCtx,
  start: SettlementDoc,
  opts: EngineOptions = {},
): Promise<SettlementDoc> {
  const steps = opts.steps ?? SETTLEMENT_STEPS;
  const maxAttempts = opts.attempts ?? STEP_ATTEMPTS;
  const backoff = opts.backoffMs ?? RPC_BACKOFF_MS;
  let settlement = start;
  if (settlement.state === 'failed') return settlement;

  for (const step of steps) {
    for (let attempt = 1; ; attempt += 1) {
      if (hasCompleted(settlement, 'done')) return settlement;
      try {
        await step.run(ctx, settlement);
        break;
      } catch (err) {
        await Settlements.updateOne(
          { _id: settlement._id },
          { $inc: { attempts: 1 }, $set: { error: `${step.name}: ${errorMessage(err)}` } },
        );
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
