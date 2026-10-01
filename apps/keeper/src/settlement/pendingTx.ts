import type { SendOpts, TxResult } from '@ibt/chain';
import type { SettlementDoc } from '@ibt/db';

import type { KeeperCtx } from '../ctx.js';

/** `pendingTx.step` is `<settlement step>:<chain step>`, e.g. `payProvider:payout`, `buyAndLock:lock`. */
export const pendingStepKey = (step: string, chainStep: string) => `${step}:${chainStep}`;

export const pendingStepOf = (key: string) => key.split(':')[0] ?? key;

export const pendingChainStepOf = (key: string) => key.split(':')[1] ?? '';

export class PendingTxUnresolvedError extends Error {
  constructor(
    readonly step: string,
    readonly signature: string,
  ) {
    super(`pendingTx ${signature} for ${step} is neither landed nor expired yet`);
    this.name = 'PendingTxUnresolvedError';
  }
}

async function clearPendingTx(settlement: SettlementDoc): Promise<void> {
  settlement.pendingTx = null;
  await settlement.save();
}

type StoredPendingTx = NonNullable<SettlementDoc['pendingTx']>;

/**
 * Polls a stored tx until it `landed`, or is `dropped` (failed, or its blockhash expired).
 * Throws `PendingTxUnresolvedError` while the tx can still land.
 */
export async function pendingTxOutcome(
  ctx: KeeperCtx,
  pending: StoredPendingTx,
): Promise<'landed' | 'dropped'> {
  for (let poll = 0; poll < ctx.config.pendingTxMaxPolls; poll += 1) {
    if (poll > 0) await ctx.sleep(ctx.config.pendingTxPollMs);
    const status = await ctx.chain.signatureStatus(pending.signature);
    if (status === 'landed') return 'landed';
    if (status === 'failed' || (await ctx.blockHeight()) > pending.lastValidBlockHeight) {
      return 'dropped';
    }
  }
  throw new PendingTxUnresolvedError(pending.step, pending.signature);
}

/**
 * G20 resume check for `step`. Resolves to the landed signature, or `null` once the
 * stored tx failed or its blockhash expired (pendingTx cleared, caller rebuilds).
 * `chainSteps` also pins the chain step, for settlement steps that send several txs.
 */
export async function resolvePendingTx(
  ctx: KeeperCtx,
  settlement: SettlementDoc,
  step: string,
  chainSteps?: readonly string[],
): Promise<string | null> {
  const pending = settlement.pendingTx;
  if (!pending) return null;
  if (
    pendingStepOf(pending.step) !== step ||
    (chainSteps && !chainSteps.includes(pendingChainStepOf(pending.step)))
  ) {
    throw new Error(`pendingTx belongs to ${pending.step}, not ${step}`);
  }
  if ((await pendingTxOutcome(ctx, pending)) === 'landed') return pending.signature;
  ctx.logger.warn({ step: pending.step, signature: pending.signature }, 'rebuild tx');
  await clearPendingTx(settlement);
  return null;
}

export interface PendingSendResult<T> {
  signature: string;
  /** `null` when the signature was recovered from a landed `pendingTx` without resending. */
  result: T | null;
}

/**
 * Sends one chain tx for a settlement step with persist-before-send (G20): `onSigned`
 * stores `pendingTx` before the tx leaves, and a landed `pendingTx` is never resent.
 * The caller records the signature and clears `pendingTx` in its state transition.
 */
export async function sendWithPendingTx<T extends TxResult>(
  ctx: KeeperCtx,
  settlement: SettlementDoc,
  step: string,
  send: (opts: SendOpts) => Promise<T>,
  chainSteps?: readonly string[],
): Promise<PendingSendResult<T>> {
  const landed = await resolvePendingTx(ctx, settlement, step, chainSteps);
  if (landed) return { signature: landed, result: null };

  const result = await send({
    settlementRef: settlement._id.toHexString(),
    onSigned: async (signature, lastValidBlockHeight, chainStep) => {
      settlement.pendingTx = {
        step: pendingStepKey(step, chainStep),
        signature,
        lastValidBlockHeight,
      };
      await settlement.save();
    },
  });
  return { signature: result.signature, result };
}
