import type { SendOpts, TxResult } from '@ibt/chain';
import { Settlements, type SettlementDoc } from '@ibt/db';
import { AppError } from '@ibt/shared';

import type { KeeperCtx } from '../ctx.js';
import { SettlementConflictError, assertLeaseHeld, saveIf } from './fence.js';

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

type StoredPendingTx = PriorTx;

/**
 * Polls a stored tx until it `landed` (confirmed or finalized), or is `dropped`: it failed, or its blockhash expired
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
    // `pending` (processed only) and `unknown` are not landed: a fork can still drop a
    // processed tx (KPR-05). Past its blockhash, the finalized re-check decides.
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
 * Signatures `onSigned` replaced (CHN-01): a send re-signed after its earlier tx was
 * judged dead. Kept in `pendingTxHistory` (written with `strict: false`, outside the
 * schema) so a resume resolves every one of them before anything is sent again.
 */
interface PriorTx {
  step: string;
  signature: string;
  lastValidBlockHeight: number;
}

const isPriorTx = (v: unknown): v is PriorTx =>
  typeof v === 'object' &&
  v !== null &&
  'step' in v &&
  typeof v.step === 'string' &&
  'signature' in v &&
  typeof v.signature === 'string' &&
  'lastValidBlockHeight' in v &&
  typeof v.lastValidBlockHeight === 'number';

async function priorTxs(settlement: SettlementDoc): Promise<PriorTx[]> {
  const raw = await Settlements.collection.findOne(
    { _id: settlement._id },
    { projection: { pendingTxHistory: 1 } },
  );
  const list: unknown = raw?.pendingTxHistory;
  return Array.isArray(list) ? list.filter(isPriorTx) : [];
}

/** Adds `prior` to the history, fenced to the settlement's lease epoch. */
async function recordPriorTx(settlement: SettlementDoc, prior: PriorTx): Promise<void> {
  const { matchedCount } = await Settlements.updateOne(
    { _id: settlement._id, leaseEpoch: settlement.leaseEpoch ?? null },
    { $addToSet: { pendingTxHistory: prior } },
    { strict: false },
  );
  if (matchedCount !== 1) {
    throw new SettlementConflictError('settlement was claimed by a newer lease epoch');
  }
}

const matchesStep = (key: string, step: string, chainSteps?: readonly string[]): boolean =>
  pendingStepOf(key) === step && (!chainSteps || chainSteps.includes(pendingChainStepOf(key)));

/** The signatures `step` signed and then replaced (`pendingTxHistory`), oldest first. */
export async function priorSignatures(
  settlement: SettlementDoc,
  step: string,
  chainSteps?: readonly string[],
): Promise<string[]> {
  return (await priorTxs(settlement))
    .filter((prior) => matchesStep(prior.step, step, chainSteps))
    .map((prior) => prior.signature);
}

/**
 * G20 resume check for `step`. Every signature this step ever signed (the stored
 * `pendingTx` and the ones it replaced) is resolved first: one still in flight throws, so
 * nothing is re-sent while it may land. Resolves to the landed signature, or `null` once
 * all of them failed or expired (pendingTx cleared, caller rebuilds).
 * `chainSteps` also pins the chain step, for settlement steps that send several txs.
 */
export async function resolvePendingTx(
  ctx: KeeperCtx,
  settlement: SettlementDoc,
  step: string,
  chainSteps?: readonly string[],
): Promise<string | null> {
  const pending = settlement.pendingTx;
  if (pending && !matchesStep(pending.step, step, chainSteps)) {
    throw new Error(`pendingTx belongs to ${pending.step}, not ${step}`);
  }
  const priors = (await priorTxs(settlement)).filter(
    (prior) => matchesStep(prior.step, step, chainSteps) && prior.signature !== pending?.signature,
  );
  const candidates: PriorTx[] = pending ? [...priors, pending] : priors;
  const landed: string[] = [];
  for (const candidate of candidates) {
    if ((await pendingTxOutcome(ctx, candidate)) === 'landed') landed.push(candidate.signature);
  }
  if (landed.length > 1) {
    await ctx.alerter.alert('error', 'more than one tx landed for one settlement step', {
      settlementId: settlement._id.toHexString(),
      step,
      signatures: landed,
    });
  }
  const first = landed[0];
  if (first) return first;
  if (!pending) return null;
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

  let own: PriorTx | null = null;
  try {
    const result = await send({
      settlementRef: settlement._id.toHexString(),
      onSigned: async (signature, lastValidBlockHeight, chainStep) => {
        assertLeaseHeld(ctx, settlement);
        const prior = own;
        const expected = {
          lastCompletedState: settlement.lastCompletedState,
          ...(prior ? { 'pendingTx.signature': prior.signature } : { pendingTx: null }),
        };
        const next = { step: pendingStepKey(step, chainStep), signature, lastValidBlockHeight };
        // A replaced signature is kept, never dropped: a resume resolves it before resending.
        if (prior && prior.step === next.step) await recordPriorTx(settlement, prior);
        settlement.pendingTx = next;
        await saveIf(settlement, expected);
        own = next;
      },
    });
    return { signature: result.signature, result };
  } catch (err) {
    await keepUnresolvedSignature(settlement, own, err);
    throw err;
  }
}

/**
 * `chain_send_failed` names the signature whose outcome is unknown. It is the stored
 * `pendingTx` (persisted before the send), and the next attempt resolves it instead of
 * re-sending; any other signature is added to the history so it is resolved too.
 */
async function keepUnresolvedSignature(
  settlement: SettlementDoc,
  own: PriorTx | null,
  err: unknown,
): Promise<void> {
  if (!(err instanceof AppError) || err.code !== 'chain_send_failed' || !own) return;
  const details: unknown = err.details;
  if (typeof details !== 'object' || details === null || !('signature' in details)) return;
  const { signature } = details;
  if (typeof signature !== 'string' || signature === own.signature) return;
  const lastValidBlockHeight =
    'lastValidBlockHeight' in details && typeof details.lastValidBlockHeight === 'number'
      ? details.lastValidBlockHeight
      : own.lastValidBlockHeight;
  await recordPriorTx(settlement, { step: own.step, signature, lastValidBlockHeight });
}
