import {
  Models,
  Requests,
  Settlements,
  Users,
  withTransaction,
  type SettlementDoc,
  type Types,
} from '@ibt/db';
import { splitRevenue, toBigInt, type SettlementState, type TokenPhase } from '@ibt/shared';
import { PublicKey } from '@solana/web3.js';

import type { KeeperCtx } from '../ctx.js';
import type { SettlementPeriod } from './period.js';
import { sendWithPendingTx } from './pendingTx.js';

/**
 * A settlement step. Steps are idempotent: each one checks `lastCompletedState` and
 * returns early when the run is already past it, so the engine can replay the whole
 * pipeline from any resume point.
 */
export type SettlementStep = (ctx: KeeperCtx, settlement: SettlementDoc) => Promise<void>;

export interface NamedStep {
  name: string;
  run: SettlementStep;
}

/** Linear progress order of `lastCompletedState` (`failed` is not a progress state). */
export const STATE_ORDER: readonly SettlementState[] = [
  'computing',
  'paid_provider',
  'converted',
  'bought',
  'locked',
  'done',
];

const rank = (state: string | null | undefined): number =>
  state ? STATE_ORDER.indexOf(state as SettlementState) : -1;

export function hasCompleted(settlement: SettlementDoc, state: SettlementState): boolean {
  return rank(settlement.lastCompletedState) >= rank(state);
}

/** Marks `state` reached; call inside the step's transaction before `save({ session })`. */
export function completeState(settlement: SettlementDoc, state: SettlementState): void {
  settlement.state = state;
  settlement.lastCompletedState = state;
}

export const tokenPhase = (status: string | null | undefined): TokenPhase =>
  status === 'curve' || status === 'graduated' ? status : 'none';

const isDuplicateKey = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;

async function loadModel(settlement: SettlementDoc) {
  const model = await Models.findById(settlement.modelId).lean();
  if (!model) throw new Error(`model ${settlement.modelId.toHexString()} not found`);
  return model;
}

/** Step 1: insert the `computing` doc; `null` when another runner already owns the period. */
export async function lease(
  _ctx: KeeperCtx,
  input: SettlementPeriod & { modelId: Types.ObjectId },
): Promise<SettlementDoc | null> {
  try {
    return await Settlements.create({
      ...input,
      state: 'computing',
      lastCompletedState: 'computing',
    });
  } catch (err) {
    if (isDuplicateKey(err)) return null;
    throw err;
  }
}

/**
 * True once the amounts are fixed: the payout step completed, or a payout was signed and
 * its `pendingTx` is still stored. Re-tagging then could pull in requests that arrived
 * after the crash and record an amount that differs from the transfer that landed.
 */
const amountsFixed = (settlement: SettlementDoc): boolean =>
  hasCompleted(settlement, 'paid_provider') || settlement.pendingTx != null;

/** Step 2: tag every untagged billable request before `periodEnd`, then sum by `settlementId`. */
export const tagAndSum: SettlementStep = async (_ctx, settlement) => {
  if (amountsFixed(settlement)) return;
  await withTransaction(async (session) => {
    await Requests.updateMany(
      {
        modelId: settlement.modelId,
        status: 'success',
        settlementId: null,
        createdAt: { $lt: settlement.periodEnd },
      },
      { $set: { settlementId: settlement._id } },
      { session },
    );
    const [sum] = await Requests.aggregate<{ total: bigint | number; count: number }>([
      { $match: { settlementId: settlement._id } },
      { $group: { _id: null, total: { $sum: '$costMicroUsdc' }, count: { $sum: 1 } } },
    ]).session(session);

    settlement.revenueMicroUsdc = toBigInt(sum?.total ?? 0n, 'revenue');
    settlement.requestCount = Number(sum?.count ?? 0);
    if (settlement.revenueMicroUsdc === 0n) {
      settlement.liquidity.phase = 'none';
      completeState(settlement, 'done');
    }
    await settlement.save({ session });
  });
};

/** Step 2b: split revenue by the model's splits and current token phase (G16/G17). */
export const split: SettlementStep = async (_ctx, settlement) => {
  if (amountsFixed(settlement)) return;
  const model = await loadModel(settlement);
  const phase = tokenPhase(model.token.status);
  const shares = splitRevenue(settlement.revenueMicroUsdc, model.splits, phase);
  settlement.provider.amountMicroUsdc = shares.providerMicro;
  settlement.liquidity.phase = phase;
  settlement.liquidity.sliceMicroUsdc = shares.liquidityMicro;
  settlement.platformMicroUsdc = shares.platformMicro;
  await settlement.save();
};

/**
 * Step 3: accrued = provider share + `token.carryOverMicroUsdc`. At least the minimum
 * pays `min(accrued, cap)` from the treasury and carries the rest (G18); below it the
 * whole amount carries over (L176). Ends in `paid_provider` either way.
 */
export const payProvider: SettlementStep = async (ctx, settlement) => {
  if (hasCompleted(settlement, 'paid_provider')) return;
  const model = await loadModel(settlement);
  const provider = await Users.findById(model.providerId, { wallet: 1 }).lean();
  if (!provider) throw new Error(`provider of model ${model.slug} not found`);

  const share =
    settlement.revenueMicroUsdc -
    settlement.liquidity.sliceMicroUsdc -
    settlement.platformMicroUsdc;
  const carry = model.token.carryOverMicroUsdc;
  const accrued = share + carry;
  const { minPayoutMicroUsdc, maxPayoutMicroUsdc } = ctx.config;
  const amount =
    accrued < minPayoutMicroUsdc ? 0n : accrued > maxPayoutMicroUsdc ? maxPayoutMicroUsdc : accrued;

  let signature: string | null = null;
  if (amount > 0n) {
    const wallet = new PublicKey(provider.wallet);
    ({ signature } = await sendWithPendingTx(ctx, settlement, 'payProvider', (opts) =>
      ctx.chain.transferUsdc(ctx.treasury, wallet, amount, opts),
    ));
  }

  await withTransaction(async (session) => {
    const { matchedCount } = await Models.updateOne(
      { _id: model._id, 'token.carryOverMicroUsdc': carry },
      { $set: { 'token.carryOverMicroUsdc': accrued - amount } },
      { session },
    );
    if (matchedCount !== 1) throw new Error(`carry-over of model ${model.slug} changed mid-run`);
    settlement.provider.amountMicroUsdc = amount;
    settlement.provider.carryOverMicroUsdc = accrued - amount;
    settlement.provider.txSignature = signature;
    settlement.pendingTx = null;
    completeState(settlement, 'paid_provider');
    await settlement.save({ session });
  });
  ctx.logger.info(
    { settlement: settlement._id.toHexString(), amount: amount.toString(), signature },
    amount > 0n ? 'provider paid' : 'provider payout carried over',
  );
};

/** Steps 2–3 in order; P6-T4/T5 append `convert`, `buyAndLock`, `compound`, `finalize`. */
export const SETTLEMENT_STEPS: readonly NamedStep[] = [
  { name: 'tagAndSum', run: tagAndSum },
  { name: 'split', run: split },
  { name: 'payProvider', run: payProvider },
];

/** Runs `steps` in order until the settlement is `done`; no retries (the engine adds them). */
export async function runSteps(
  ctx: KeeperCtx,
  settlement: SettlementDoc,
  steps: readonly NamedStep[],
): Promise<void> {
  for (const step of steps) {
    if (hasCompleted(settlement, 'done')) return;
    await step.run(ctx, settlement);
  }
}
