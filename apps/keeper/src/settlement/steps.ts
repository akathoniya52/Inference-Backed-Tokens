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
  type SettlementState,
  type TokenPhase,
} from '@ibt/shared';
import { PublicKey } from '@solana/web3.js';

import type { KeeperCtx } from '../ctx.js';
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

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** USD per SOL from the price source as integer micro-USDC per SOL. */
export function solPriceMicro(usdPerSol: number): bigint {
  if (!Number.isFinite(usdPerSol) || usdPerSol <= 0) {
    throw new RangeError(`invalid SOL price ${usdPerSol}`);
  }
  return BigInt(Math.round(usdPerSol * 1e6));
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
      await settlement.save({ session });
    });
    return;
  }

  const model = await loadModel(settlement);
  const priceMicro = solPriceMicro(await ctx.price.solUsd());
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
    await settlement.save({ session });
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

type ModelRow = Awaited<ReturnType<typeof loadModel>>;

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
    await withTransaction((session) => settlement.save({ session }));
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
    await settlement.save({ session });
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
    await settlement.save({ session });
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
    await settlement.save({ session });
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
    await withTransaction((session) => settlement.save({ session }));
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
  throw new Error(
    `liquidity add ${addSignature ?? pending.signature} landed without its lock; lock the keeper position before retrying`,
  );
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
    await settlement.save({ session });
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

/** Steps 2–5 in order; P6-T5 appends `compound` and `finalize`. */
export const SETTLEMENT_STEPS: readonly NamedStep[] = [...PROVIDER_STEPS, ...LIQUIDITY_STEPS];

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
