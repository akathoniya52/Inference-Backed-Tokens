import {
  Models,
  Requests,
  Settlements,
  Users,
  withTransaction,
  type SettlementDoc,
  type Types,
} from '@ibt/db';
import { NATIVE_MINT, type AddAndLockResult, type PositionKeys } from '@ibt/chain';
import {
  LAMPORTS_PER_SOL,
  ceilDiv,
  microToUsdcString,
  sliceToLamports,
  splitRevenue,
  toBigInt,
  usdcStringToMicro,
  type SettlementState,
  type TokenPhase,
} from '@ibt/shared';
import { PublicKey } from '@solana/web3.js';

import type { KeeperCtx } from '../ctx.js';
import { saveIf } from './fence.js';
import type { SettlementPeriod } from './period.js';
import {
  pendingChainStepOf,
  pendingStepKey,
  pendingTxOutcome,
  sendWithPendingTx,
} from './pendingTx.js';

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

/** A failure retrying cannot fix; the engine fails the settlement at once and alerts. */
export class NonRetryableSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableSettlementError';
  }
}

/** An add landed but its lock did not: unlocked liquidity needs a manual lock first. */
export class LiquidityUnlockedError extends NonRetryableSettlementError {
  constructor(readonly addSignature: string) {
    super(
      `liquidity add ${addSignature} landed without its lock; lock the keeper position before retrying`,
    );
    this.name = 'LiquidityUnlockedError';
  }
}

/** The L375 invariant does not hold for a settlement about to be marked `done`. */
export class SettlementInvariantError extends NonRetryableSettlementError {
  constructor(reason: string) {
    super(`settlement invariant violated: ${reason}`);
    this.name = 'SettlementInvariantError';
  }
}

const isDuplicateKey = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;

async function loadModel(settlement: SettlementDoc) {
  const model = await Models.findById(settlement.modelId).lean();
  if (!model) throw new Error(`model ${settlement.modelId.toHexString()} not found`);
  return model;
}

type ModelRow = Awaited<ReturnType<typeof loadModel>>;

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
  hasCompleted(settlement, 'paid_provider') ||
  settlement.pendingTx != null ||
  settlement.provider.reserved;

/** Stored state under which tagging and splitting may still (re)write the amounts. */
const AMOUNTS_OPEN = {
  lastCompletedState: 'computing',
  pendingTx: null,
  'provider.reserved': { $ne: true },
} as const;

/**
 * Step 2: tag every untagged billed request before `periodEnd`, then sum by `settlementId`.
 * Billed means captured (`costMicroUsdc > 0`), whatever the status: a stream cut short
 * after delivering output is charged and recorded as `client_abort`/`timeout`/
 * `upstream_error`. Released requests are stored with cost 0 and never tagged.
 */
export const tagAndSum: SettlementStep = async (_ctx, settlement) => {
  if (amountsFixed(settlement)) return;
  await withTransaction(async (session) => {
    await Requests.updateMany(
      {
        modelId: settlement.modelId,
        costMicroUsdc: { $gt: 0n },
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
    await saveIf(settlement, AMOUNTS_OPEN, session);
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
  await saveIf(settlement, AMOUNTS_OPEN);
};

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * `min(accrued, MAX_PAYOUT_USDC_PER_RUN, what the run has left of it)`; below the minimum
 * the whole amount carries over (L176, G18).
 */
function payoutAmount(ctx: KeeperCtx, accrued: bigint): bigint {
  const { minPayoutMicroUsdc, maxPayoutMicroUsdc } = ctx.config;
  const runLeft = ctx.payoutBudget?.remainingMicroUsdc ?? maxPayoutMicroUsdc;
  const capped = min(min(accrued, maxPayoutMicroUsdc), runLeft);
  return capped < minPayoutMicroUsdc ? 0n : capped;
}

/**
 * Fixes the payout before anything is sent: the model's carry-over is consumed with a
 * compare-and-set in the same transaction that stores amount and new carry-over on the
 * settlement, so no two settlements (or runners) can pay the same carry-over.
 */
async function reservePayout(
  ctx: KeeperCtx,
  settlement: SettlementDoc,
  model: ModelRow,
): Promise<void> {
  const share =
    settlement.revenueMicroUsdc -
    settlement.liquidity.sliceMicroUsdc -
    settlement.platformMicroUsdc;
  const carry = model.token.carryOverMicroUsdc;
  const accrued = share + carry;
  const amount = payoutAmount(ctx, accrued);
  // Taken before the first await so the run's concurrent settlements see it at once.
  if (ctx.payoutBudget) ctx.payoutBudget.remainingMicroUsdc -= amount;
  try {
    await withTransaction(async (session) => {
      const { matchedCount } = await Models.updateOne(
        { _id: model._id, 'token.carryOverMicroUsdc': carry },
        { $set: { 'token.carryOverMicroUsdc': accrued - amount } },
        { session },
      );
      if (matchedCount !== 1) throw new Error(`carry-over of model ${model.slug} changed mid-run`);
      settlement.provider.amountMicroUsdc = amount;
      settlement.provider.carryOverMicroUsdc = accrued - amount;
      settlement.provider.reserved = true;
      await saveIf(settlement, AMOUNTS_OPEN, session);
    });
  } catch (err) {
    if (ctx.payoutBudget) ctx.payoutBudget.remainingMicroUsdc += amount;
    throw err;
  }
}

/**
 * Step 3: accrued = provider share + `token.carryOverMicroUsdc`. At least the minimum
 * pays `min(accrued, cap, run budget)` from the treasury and carries the rest (G18); below
 * it the whole amount carries over (L176). The amount is reserved before the transfer is
 * signed, and the step ends in `paid_provider` either way.
 */
export const payProvider: SettlementStep = async (ctx, settlement) => {
  if (hasCompleted(settlement, 'paid_provider')) return;
  const model = await loadModel(settlement);
  const provider = await Users.findById(model.providerId, { wallet: 1 }).lean();
  if (!provider) throw new Error(`provider of model ${model.slug} not found`);
  if (!settlement.provider.reserved) await reservePayout(ctx, settlement, model);
  const amount = settlement.provider.amountMicroUsdc;

  let signature: string | null = null;
  if (amount > 0n) {
    const wallet = new PublicKey(provider.wallet);
    ({ signature } = await sendWithPendingTx(ctx, settlement, 'payProvider', (opts) =>
      ctx.chain.transferUsdc(ctx.treasury, wallet, amount, opts),
    ));
  }

  settlement.provider.txSignature = signature;
  settlement.pendingTx = null;
  completeState(settlement, 'paid_provider');
  await saveIf(settlement, { lastCompletedState: 'computing' });
  ctx.logger.info(
    { settlement: settlement._id.toHexString(), amount: amount.toString(), signature },
    amount > 0n ? 'provider paid' : 'provider payout carried over',
  );
};

/** Sanity bounds for the SOL price source (E5); a price outside them is never spent at. */
export const SOL_PRICE_MIN_USD = 1;
export const SOL_PRICE_MAX_USD = 100_000;
/** Largest move, in percent, from the price the last converted settlement stored. */
export const SOL_PRICE_MAX_DEVIATION_PCT = 30n;

/** The SOL price failed a sanity check; retried, and nothing is spent at it. */
export class SolPriceRejectedError extends Error {
  constructor(reason: string) {
    super(`SOL price rejected: ${reason}`);
    this.name = 'SolPriceRejectedError';
  }
}

/** USD per SOL from the price source as integer micro-USDC per SOL. */
export function solPriceMicro(usdPerSol: number): bigint {
  if (!Number.isFinite(usdPerSol) || usdPerSol <= 0) {
    throw new RangeError(`invalid SOL price ${usdPerSol}`);
  }
  return BigInt(Math.round(usdPerSol * 1e6));
}

async function lastStoredSolPriceMicro(): Promise<bigint | null> {
  const last = await Settlements.findOne(
    { 'liquidity.solPriceUsdc': { $ne: null } },
    { 'liquidity.solPriceUsdc': 1 },
  )
    .sort({ updatedAt: -1 })
    .lean();
  const stored = last?.liquidity.solPriceUsdc;
  return stored ? usdcStringToMicro(stored) : null;
}

/** The source price as micro-USDC per SOL, after the E5 checks; a rejection alerts and throws. */
async function checkedSolPriceMicro(ctx: KeeperCtx, settlement: SettlementDoc): Promise<bigint> {
  const usdPerSol = await ctx.price.solUsd();
  let reason: string | null = null;
  if (!(usdPerSol >= SOL_PRICE_MIN_USD && usdPerSol <= SOL_PRICE_MAX_USD)) {
    reason = `${usdPerSol} USD is outside [${SOL_PRICE_MIN_USD}, ${SOL_PRICE_MAX_USD}]`;
  } else {
    const last = await lastStoredSolPriceMicro();
    const priceMicro = solPriceMicro(usdPerSol);
    const move = last === null ? 0n : priceMicro > last ? priceMicro - last : last - priceMicro;
    if (last !== null && move * 100n > last * SOL_PRICE_MAX_DEVIATION_PCT) {
      reason = `${usdPerSol} USD moved more than ${SOL_PRICE_MAX_DEVIATION_PCT}% from the last stored ${microToUsdcString(last)}`;
    } else {
      return priceMicro;
    }
  }
  await ctx.alerter.alert('warn', 'SOL price rejected', {
    settlementId: settlement._id.toHexString(),
    usdPerSol,
    reason,
  });
  throw new SolPriceRejectedError(reason);
}

export interface SliceConversion {
  /** Lamports the liquidity step spends this run. */
  lamports: bigint;
  /** New `token.pendingCompoundLamports`. */
  compoundLeft: bigint;
  /** New `token.sliceCarryOverMicroUsdc`. */
  carryMicro: bigint;
}

/**
 * Step 4 maths. Compound lamports are SOL already on hand and are spent first; the
 * slice plus carry-over is priced at `priceMicro`. Everything is capped at `maxLamports`
 * (G18). USDC the cap leaves unspent, or that floors to 0 lamports, stays carried over;
 * the spent part is valued rounding up so the float never covers more than it was paid.
 */
export function convertSlice(input: {
  usdcMicro: bigint;
  compoundLamports: bigint;
  priceMicro: bigint;
  maxLamports: bigint;
}): SliceConversion {
  const compoundUsed = min(input.compoundLamports, input.maxLamports);
  const full = sliceToLamports(input.usdcMicro, input.priceMicro);
  const usdcLamports = min(full, input.maxLamports - compoundUsed);
  const spentMicro =
    usdcLamports === 0n
      ? 0n
      : usdcLamports === full
        ? input.usdcMicro
        : min(input.usdcMicro, ceilDiv(usdcLamports * input.priceMicro, LAMPORTS_PER_SOL));
  return {
    lamports: compoundUsed + usdcLamports,
    compoundLeft: input.compoundLamports - compoundUsed,
    carryMicro: input.usdcMicro - spentMicro,
  };
}

/**
 * Step 4: price the slice, take `sliceCarryOver` and `pendingCompoundLamports` into it,
 * cap it and persist the rate and lamports before anything is sent. Dust (0 lamports)
 * carries the slice over and finishes the run with phase `none` (L375).
 */
export const convert: SettlementStep = async (ctx, settlement) => {
  if (hasCompleted(settlement, 'converted')) return;
  if (settlement.liquidity.phase === 'none') {
    await withTransaction(async (session) => {
      settlement.liquidity.solLamports = 0n;
      completeState(settlement, 'converted');
      await saveIf(settlement, { lastCompletedState: 'paid_provider' }, session);
    });
    return;
  }

  const model = await loadModel(settlement);
  const priceMicro = await checkedSolPriceMicro(ctx, settlement);
  const carry = model.token.sliceCarryOverMicroUsdc;
  const compound = model.token.pendingCompoundLamports;
  const { lamports, compoundLeft, carryMicro } = convertSlice({
    usdcMicro: settlement.liquidity.sliceMicroUsdc + carry,
    compoundLamports: compound,
    priceMicro,
    maxLamports: ctx.config.maxSliceLamports,
  });
  const dust = lamports === 0n;

  await withTransaction(async (session) => {
    const { matchedCount } = await Models.updateOne(
      {
        _id: model._id,
        'token.sliceCarryOverMicroUsdc': carry,
        'token.pendingCompoundLamports': compound,
      },
      {
        $set: {
          'token.sliceCarryOverMicroUsdc': carryMicro,
          'token.pendingCompoundLamports': compoundLeft,
        },
      },
      { session },
    );
    if (matchedCount !== 1)
      throw new Error(`slice carry-over of model ${model.slug} changed mid-run`);
    settlement.liquidity.solPriceUsdc = microToUsdcString(priceMicro);
    settlement.liquidity.solLamports = lamports;
    if (dust) {
      settlement.liquidity.phase = 'none';
      completeState(settlement, 'done');
    } else {
      completeState(settlement, 'converted');
    }
    await saveIf(settlement, { lastCompletedState: 'paid_provider' }, session);
  });
  ctx.logger.info(
    {
      settlement: settlement._id.toHexString(),
      lamports: lamports.toString(),
      solPriceUsdc: settlement.liquidity.solPriceUsdc,
      sliceCarryOverMicroUsdc: carryMicro.toString(),
    },
    dust ? 'slice is dust, carried over' : 'slice converted',
  );
};

function tokenMint(model: ModelRow): PublicKey {
  if (!model.token.mint) throw new Error(`model ${model.slug} has no token mint`);
  return new PublicKey(model.token.mint);
}

/**
 * `token.keeperPositionNftAccount` is new in `@ibt/db`; the keeper's injected copy of the
 * package can predate it until the next install, hence the widened type and the
 * `strict: false` write in `addAndLockLiquidity`.
 */
interface TokenPosition {
  keeperPosition?: string | null;
  keeperPositionNftAccount?: string | null;
}

function keeperPosition(model: ModelRow): PositionKeys | null {
  const token: TokenPosition = model.token;
  const { keeperPosition: position, keeperPositionNftAccount: nftAccount } = token;
  return position && nftAccount
    ? { position: new PublicKey(position), positionNftAccount: new PublicKey(nftAccount) }
    : null;
}

/**
 * Tokens a landed buy or swap delivered when its result was lost in a crash: the
 * keeper's balance of the mint above the recorded escrow (the keeper holds nothing else
 * of a model's mint).
 */
async function recoveredTokens(ctx: KeeperCtx, model: ModelRow): Promise<bigint> {
  const balance = await ctx.chain.tokenBalance(ctx.keeper.publicKey, tokenMint(model));
  const escrow = model.token.escrowBaseUnits;
  return balance > escrow ? balance - escrow : 0n;
}

/** Curve buy (PartialFill): spends at most the room left on the curve, the rest compounds. */
async function buyOnCurve(
  ctx: KeeperCtx,
  settlement: SettlementDoc,
  model: ModelRow,
  pool: PublicKey,
): Promise<void> {
  const lamports = settlement.liquidity.solLamports ?? 0n;
  if (settlement.liquidity.solAddedLamports == null) {
    const state = await ctx.chain.readPool({ pool });
    if (!state) throw new Error(`DBC pool ${pool.toBase58()} not found`);
    const room = state.isMigrated
      ? 0n
      : BigInt(state.migrationQuoteThreshold) - BigInt(state.quoteReserve);
    settlement.liquidity.solAddedLamports = room > 0n ? min(lamports, room) : 0n;
    await saveIf(settlement, { lastCompletedState: 'converted', pendingTx: null });
  }
  const spend = settlement.liquidity.solAddedLamports;

  let signature: string | null = null;
  let tokens = 0n;
  if (spend > 0n) {
    const sent = await sendWithPendingTx(
      ctx,
      settlement,
      'buyAndLock',
      (opts) => ctx.chain.curveBuy(ctx.keeper, pool, spend, opts),
      ['curveBuy'],
    );
    signature = sent.signature;
    tokens = sent.result ? sent.result.outAmount : await recoveredTokens(ctx, model);
  }

  await withTransaction(async (session) => {
    await Models.updateOne(
      { _id: model._id },
      {
        $inc: {
          'token.escrowBaseUnits': tokens,
          'token.pendingCompoundLamports': lamports - spend,
        },
      },
      { session },
    );
    settlement.liquidity.buyTxSignature = signature;
    settlement.liquidity.tokensBaseUnits = tokens;
    settlement.pendingTx = null;
    completeState(settlement, 'bought');
    await saveIf(settlement, { lastCompletedState: 'converted' }, session);
  });
  ctx.logger.info(
    {
      settlement: settlement._id.toHexString(),
      spend: spend.toString(),
      tokens: tokens.toString(),
    },
    'bought on the curve',
  );
}

async function curveNeedsMigration(
  ctx: KeeperCtx,
  model: ModelRow,
  pool: PublicKey,
): Promise<boolean> {
  const fresh = await Models.findById(model._id, { 'token.migrationSignature': 1 }).lean();
  if (fresh?.token.migrationSignature) return false;
  const state = await ctx.chain.readPool({ pool });
  return (
    state !== null &&
    !state.isMigrated &&
    BigInt(state.quoteReserve) >= BigInt(state.migrationQuoteThreshold)
  );
}

/** L178: a buy that completes the curve migrates it in the same run. */
async function migrateIfComplete(
  ctx: KeeperCtx,
  settlement: SettlementDoc,
  model: ModelRow,
  pool: PublicKey,
): Promise<void> {
  let signature: string | null = null;
  if (settlement.pendingTx || (await curveNeedsMigration(ctx, model, pool))) {
    ({ signature } = await sendWithPendingTx(
      ctx,
      settlement,
      'buyAndLock',
      (opts) =>
        ctx.chain.migrate(ctx.keeper, pool, {
          ...opts,
          onSigned: async (sig, lastValidBlockHeight, chainStep) => {
            await opts.onSigned?.(sig, lastValidBlockHeight, chainStep);
            await withTransaction((session) =>
              Models.updateOne(
                { _id: model._id },
                { $set: { 'token.migrationSignature': sig } },
                { session },
              ),
            );
          },
        }),
      ['migrate'],
    ));
  }

  await withTransaction(async (session) => {
    settlement.liquidity.migrationSignature = signature;
    settlement.liquidity.lockTxSignature = null;
    settlement.pendingTx = null;
    completeState(settlement, 'locked');
    await saveIf(settlement, { lastCompletedState: 'bought' }, session);
  });
  if (signature) {
    ctx.logger.info({ settlement: settlement._id.toHexString(), signature }, 'curve migrated');
  }
}

/** Graduated, empty escrow: swap half the lamports to tokens, which then sit in escrow. */
async function swapHalfIfNoEscrow(
  ctx: KeeperCtx,
  settlement: SettlementDoc,
  model: ModelRow,
): Promise<void> {
  const lamports = settlement.liquidity.solLamports ?? 0n;
  const swapIn = model.token.escrowBaseUnits === 0n ? lamports / 2n : 0n;
  let signature: string | null = null;
  let tokens = 0n;
  if (swapIn > 0n) {
    const mint = tokenMint(model);
    const sent = await sendWithPendingTx(
      ctx,
      settlement,
      'buyAndLock',
      (opts) =>
        ctx.chain.dammSwap(ctx.keeper, mint, { inputMint: NATIVE_MINT, amountIn: swapIn }, opts),
      ['dammSwap'],
    );
    signature = sent.signature;
    tokens = sent.result ? sent.result.outAmount : await recoveredTokens(ctx, model);
  }

  await withTransaction(async (session) => {
    if (tokens > 0n) {
      await Models.updateOne(
        { _id: model._id },
        { $inc: { 'token.escrowBaseUnits': tokens } },
        { session },
      );
    }
    settlement.liquidity.swapTxSignature = signature;
    settlement.pendingTx = null;
    completeState(settlement, 'bought');
    await saveIf(settlement, { lastCompletedState: 'converted' }, session);
  });
}

type AddLockOutcome = Pick<
  AddAndLockResult,
  'addSignature' | 'lockSignature' | 'lamportsUsed' | 'tokensUsed'
> & { keys: PositionKeys | null };

/**
 * `addAndLock` sends two txs and the chain client cannot lock on its own, so a stored
 * `pendingTx` is only safe to act on in two cases: the add never landed (rebuild both),
 * or the lock landed (record both; amounts recovered from the escrow balance). Any
 * other outcome leaves unlocked liquidity and fails the step instead of adding twice.
 */
async function resumeAddAndLock(
  ctx: KeeperCtx,
  settlement: SettlementDoc,
  model: ModelRow,
  addLamports: bigint,
): Promise<AddLockOutcome | null> {
  const pending = settlement.pendingTx;
  if (!pending) return null;
  const chainStep = pendingChainStepOf(pending.step);
  if (pending.step !== pendingStepKey('buyAndLock', chainStep)) {
    throw new Error(`pendingTx belongs to ${pending.step}, not buyAndLock`);
  }
  const outcome = await pendingTxOutcome(ctx, pending);
  const addSignature = settlement.liquidity.addTxSignature;
  if (chainStep === 'addLiquidity' && outcome === 'dropped') {
    settlement.pendingTx = null;
    await saveIf(settlement, { 'pendingTx.signature': pending.signature });
    return null;
  }
  if (chainStep === 'lock' && outcome === 'landed' && addSignature) {
    const balance = await ctx.chain.tokenBalance(ctx.keeper.publicKey, tokenMint(model));
    const escrow = model.token.escrowBaseUnits;
    return {
      addSignature,
      lockSignature: pending.signature,
      lamportsUsed: addLamports,
      tokensUsed: escrow > balance ? escrow - balance : 0n,
      keys: keeperPosition(model),
    };
  }
  throw new LiquidityUnlockedError(addSignature ?? pending.signature);
}

/** Graduated: pair escrow (bought on the curve or just swapped) with SOL, then lock it. */
async function addAndLockLiquidity(
  ctx: KeeperCtx,
  settlement: SettlementDoc,
  model: ModelRow,
): Promise<void> {
  const lamports = settlement.liquidity.solLamports ?? 0n;
  const addLamports = settlement.liquidity.swapTxSignature ? lamports - lamports / 2n : lamports;
  const escrow = model.token.escrowBaseUnits;
  const position = keeperPosition(model);
  const mint = tokenMint(model);

  let outcome = await resumeAddAndLock(ctx, settlement, model, addLamports);
  if (!outcome && addLamports > 0n && escrow > 0n) {
    const { result } = await sendWithPendingTx(
      ctx,
      settlement,
      'buyAndLock',
      async (opts) => {
        const added = await ctx.chain.addAndLock(
          ctx.keeper,
          mint,
          { position, lamports: addLamports, maxTokens: escrow },
          {
            ...opts,
            onSigned: async (sig, lastValidBlockHeight, chainStep) => {
              // The add confirmed before the lock was built, so keep its signature.
              if (chainStep === 'lock' && settlement.pendingTx) {
                settlement.liquidity.addTxSignature = settlement.pendingTx.signature;
              }
              await opts.onSigned?.(sig, lastValidBlockHeight, chainStep);
            },
          },
        );
        return { ...added, signature: added.lockSignature };
      },
      ['addLiquidity'],
    );
    if (result) {
      outcome = {
        addSignature: result.addSignature,
        lockSignature: result.lockSignature,
        lamportsUsed: result.lamportsUsed,
        tokensUsed: result.tokensUsed,
        keys: { position: result.position, positionNftAccount: result.positionNftAccount },
      };
    }
  }

  const lamportsUsed = outcome?.lamportsUsed ?? 0n;
  const tokensUsed = outcome?.tokensUsed ?? 0n;
  const newKeys = !position && outcome?.keys ? outcome.keys : null;
  await withTransaction(async (session) => {
    await Models.updateOne(
      { _id: model._id },
      {
        $inc: {
          'token.escrowBaseUnits': -tokensUsed,
          'token.pendingCompoundLamports': addLamports - lamportsUsed,
        },
        ...(newKeys
          ? {
              $set: {
                'token.keeperPosition': newKeys.position.toBase58(),
                'token.keeperPositionNftAccount': newKeys.positionNftAccount.toBase58(),
              },
            }
          : {}),
      },
      { session, strict: false },
    );
    settlement.liquidity.addTxSignature = outcome?.addSignature ?? null;
    settlement.liquidity.lockTxSignature = outcome?.lockSignature ?? null;
    settlement.liquidity.tokensBaseUnits = tokensUsed;
    settlement.liquidity.solAddedLamports = lamportsUsed;
    settlement.pendingTx = null;
    completeState(settlement, 'locked');
    await saveIf(settlement, { lastCompletedState: 'bought' }, session);
  });
  ctx.logger.info(
    {
      settlement: settlement._id.toHexString(),
      lamports: lamportsUsed.toString(),
      tokens: tokensUsed.toString(),
      lockSignature: outcome?.lockSignature ?? null,
    },
    outcome ? 'liquidity added and locked' : 'nothing to add',
  );
}

/**
 * The phase is re-read from the model at this step (a token can graduate after `split`)
 * and pinned once a send for it may have happened, so a resume never switches paths.
 */
function liquidityPhase(settlement: SettlementDoc, model: ModelRow): TokenPhase {
  if (!settlement.pendingTx && !hasCompleted(settlement, 'bought')) {
    settlement.liquidity.phase = tokenPhase(model.token.status);
  }
  return settlement.liquidity.phase;
}

/** Step 5: curve buy (+ migration) or graduated add-and-lock; phase `none` skips. */
export const buyAndLock: SettlementStep = async (ctx, settlement) => {
  if (hasCompleted(settlement, 'locked')) return;
  const model = await loadModel(settlement);
  const phase = liquidityPhase(settlement, model);

  if (phase === 'curve') {
    if (!model.token.dbcPool) throw new Error(`model ${model.slug} is on the curve without a pool`);
    const pool = new PublicKey(model.token.dbcPool);
    if (!hasCompleted(settlement, 'bought')) await buyOnCurve(ctx, settlement, model, pool);
    await migrateIfComplete(ctx, settlement, model, pool);
    return;
  }
  if (phase === 'graduated') {
    if (!hasCompleted(settlement, 'bought')) await swapHalfIfNoEscrow(ctx, settlement, model);
    await addAndLockLiquidity(ctx, settlement, await loadModel(settlement));
    return;
  }

  const lamports = settlement.liquidity.solLamports ?? 0n;
  await withTransaction(async (session) => {
    if (lamports > 0n) {
      await Models.updateOne(
        { _id: model._id },
        { $inc: { 'token.pendingCompoundLamports': lamports } },
        { session },
      );
    }
    completeState(settlement, 'locked');
    await saveIf(settlement, { lastCompletedState: 'converted' }, session);
  });
};

const gain = (before: bigint, after: bigint): bigint => (after > before ? after - before : 0n);

let claimQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs fee claims one at a time across the process (E6). A claim's amounts are the keeper's
 * balance gain across it, and another model's claim landing in between would be counted too.
 */
function oneClaimAtATime<T>(claim: () => Promise<T>): Promise<T> {
  const run = claimQueue.then(claim, claim);
  claimQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Step 6: claim the keeper position's fees (L179, G19). The chain client reports no
 * amounts, so they are the keeper's balance gain across the claim. Claims are serialized
 * across models (the only keeper txs that add SOL), and other models' concurrent sends only
 * spend SOL, so the measurement can undercount but never overcount.
 * Lamports compound into the next run's slice, base-token fees join the escrow (L127).
 * A claim recovered from a landed `pendingTx` records its signature with zero amounts.
 */
export const compound: SettlementStep = async (ctx, settlement) => {
  if (hasCompleted(settlement, 'done') || settlement.liquidity.claimTxSignature) return;
  const model = await loadModel(settlement);
  const position = keeperPosition(model);
  if (model.token.status !== 'graduated' || !position) {
    if (settlement.pendingTx) throw new Error(`pendingTx belongs to ${settlement.pendingTx.step}`);
    return;
  }
  const mint = tokenMint(model);
  const owner = ctx.keeper.publicKey;
  const { signature, lamports, tokens, recovered } = await oneClaimAtATime(async () => {
    const solBefore = await ctx.chain.solBalance(owner);
    const tokensBefore = await ctx.chain.tokenBalance(owner, mint);
    const sent = await sendWithPendingTx(ctx, settlement, 'compound', (opts) =>
      ctx.chain.claimPositionFee(ctx.keeper, mint, position, opts),
    );
    if (!sent.result)
      return { signature: sent.signature, lamports: 0n, tokens: 0n, recovered: true };
    return {
      signature: sent.signature,
      lamports: gain(solBefore, await ctx.chain.solBalance(owner)),
      tokens: gain(tokensBefore, await ctx.chain.tokenBalance(owner, mint)),
      recovered: false,
    };
  });
  if (recovered) {
    ctx.logger.warn(
      { settlement: settlement._id.toHexString(), signature },
      'fee claim recovered from pendingTx; claimed amounts unknown',
    );
  }

  await withTransaction(async (session) => {
    await Models.updateOne(
      { _id: model._id },
      {
        $inc: {
          'token.pendingCompoundLamports': lamports,
          'token.escrowBaseUnits': tokens,
        },
      },
      { session },
    );
    settlement.liquidity.claimTxSignature = signature;
    settlement.pendingTx = null;
    await saveIf(
      settlement,
      { lastCompletedState: 'locked', 'liquidity.claimTxSignature': null },
      session,
    );
  });
  ctx.logger.info(
    {
      settlement: settlement._id.toHexString(),
      signature,
      lamports: lamports.toString(),
      tokens: tokens.toString(),
    },
    'position fees claimed',
  );
};

/**
 * L375: a `done` settlement has a provider signature or a carry-over (nothing paid), and
 * liquidity signatures or phase `none`. Liquidity that spent no lamports needs no
 * signature (a full curve, or nothing to pair). Returns the violation, or `null`.
 */
export function doneInvariantViolation(settlement: SettlementDoc): string | null {
  const { provider, liquidity } = settlement;
  if (provider.amountMicroUsdc > 0n && !provider.txSignature) {
    return 'provider amount paid without a signature';
  }
  if (liquidity.phase === 'none') return null;
  const spent = (liquidity.solAddedLamports ?? 0n) > 0n;
  if (liquidity.phase === 'curve' && spent && !liquidity.buyTxSignature) {
    return 'curve buy without a signature';
  }
  if (
    liquidity.phase === 'graduated' &&
    spent &&
    !(liquidity.addTxSignature && liquidity.lockTxSignature)
  ) {
    return 'liquidity added without add and lock signatures';
  }
  return null;
}

/** Step 7: check the L375 invariant and mark the settlement `done`. */
export const finalize: SettlementStep = async (_ctx, settlement) => {
  if (hasCompleted(settlement, 'done')) return;
  const violation = doneInvariantViolation(settlement);
  if (violation) throw new SettlementInvariantError(violation);
  await withTransaction(async (session) => {
    settlement.pendingTx = null;
    settlement.error = null;
    completeState(settlement, 'done');
    await settlement.save({ session });
  });
};

/** Steps 2–3: everything up to the provider payout. */
export const PROVIDER_STEPS: readonly NamedStep[] = [
  { name: 'tagAndSum', run: tagAndSum },
  { name: 'split', run: split },
  { name: 'payProvider', run: payProvider },
];

/** Steps 4–5: the liquidity slice. */
export const LIQUIDITY_STEPS: readonly NamedStep[] = [
  { name: 'convert', run: convert },
  { name: 'buyAndLock', run: buyAndLock },
];

/** Steps 6–7: fee claim and finalize. */
export const FINAL_STEPS: readonly NamedStep[] = [
  { name: 'compound', run: compound },
  { name: 'finalize', run: finalize },
];

/** Steps 2–7 in order. */
export const SETTLEMENT_STEPS: readonly NamedStep[] = [
  ...PROVIDER_STEPS,
  ...LIQUIDITY_STEPS,
  ...FINAL_STEPS,
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
