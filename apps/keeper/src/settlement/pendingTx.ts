import type { SendOpts, TxResult } from '@ibt/chain';
import type { SettlementDoc } from '@ibt/db';

import type { KeeperCtx } from '../ctx.js';
import { assertLeaseHeld, saveIf } from './fence.js';

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

/** An expired tx the RPC cannot place (no history): never resent, resolved by hand or a later run. */
export class PendingTxUnknownError extends Error {
  constructor(
    readonly step: string,
    readonly signature: string,
  ) {
    super(`pendingTx ${signature} for ${step} expired but its status is unknown; not resending`);
    this.name = 'PendingTxUnknownError';
  }
}

/** Clears the stored tx only if it is still `signature`, so a concurrent runner's tx survives. */
async function clearPendingTx(settlement: SettlementDoc, signature: string): Promise<void> {
  settlement.pendingTx = null;
  await saveIf(settlement, { 'pendingTx.signature': signature });
}

type StoredPendingTx = NonNullable<SettlementDoc['pendingTx']>;

/**
 * Polls a stored tx until it `landed`, or is `dropped`: it failed, or its blockhash expired
 * and the finalized re-check (E4) finds it absent from history. An expired tx the re-check
 * cannot place stays stored and throws `PendingTxUnknownError` (alerted); one that can still
 * land throws `PendingTxUnresolvedError`.
 */
export async function pendingTxOutcome(
  ctx: KeeperCtx,
  pending: StoredPendingTx,
): Promise<'landed' | 'dropped'> {
  let expiredUnknown = false;
  for (let poll = 0; poll < ctx.config.pendingTxMaxPolls; poll += 1) {
    if (poll > 0) await ctx.sleep(ctx.config.pendingTxPollMs);
    const status = await ctx.chain.signatureStatus(pending.signature);
    if (status === 'landed') return 'landed';
    if (status === 'failed') return 'dropped';
    if ((await ctx.blockHeight()) > pending.lastValidBlockHeight) {
      const final = await ctx.chain.expiredSignatureStatus(
        pending.signature,
        pending.lastValidBlockHeight,
      );
      if (final === 'landed') return 'landed';
      if (final === 'failed' || final === 'absent') return 'dropped';
      expiredUnknown = true;
    }
  }
  if (expiredUnknown) {
    await ctx.alerter.alert('error', 'pendingTx expired with unknown status; not resending', {
      step: pending.step,
      signature: pending.signature,
    });
    throw new PendingTxUnknownError(pending.step, pending.signature);
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
  await clearPendingTx(settlement, pending.signature);
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
 * The store is a compare-and-set (E2): it needs the lease held in the settlement's epoch,
 * the state this runner loaded and no other runner's `pendingTx` (only this send's own
 * earlier signature may be replaced); otherwise `onSigned` throws and nothing is sent.
 * The caller records the signature and clears `pendingTx` in its state transition.
 */
export async function sendWithPendingTx<T extends TxResult>(
  ctx: KeeperCtx,
  settlement: SettlementDoc,
  step: string,
  send: (opts: SendOpts) => Promise<T>,
  chainSteps?: readonly string[],
): Promise<PendingSendResult<T>> {
  assertLeaseHeld(ctx, settlement);
  const landed = await resolvePendingTx(ctx, settlement, step, chainSteps);
  if (landed) return { signature: landed, result: null };

  let ownSignature: string | null = null;
  const result = await send({
    settlementRef: settlement._id.toHexString(),
    onSigned: async (signature, lastValidBlockHeight, chainStep) => {
      assertLeaseHeld(ctx, settlement);
      const expected = {
        lastCompletedState: settlement.lastCompletedState,
        ...(ownSignature ? { 'pendingTx.signature': ownSignature } : { pendingTx: null }),
      };
      settlement.pendingTx = {
        step: pendingStepKey(step, chainStep),
        signature,
        lastValidBlockHeight,
      };
      await saveIf(settlement, expected);
      ownSignature = signature;
    },
  });
  return { signature: result.signature, result };
}
