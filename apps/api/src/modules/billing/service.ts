import { ataOf, USDC_MINT, type DepositRejection } from '@ibt/chain';
import {
  Deposits,
  Ledger,
  Models,
  Requests,
  Types,
  Users,
  credit,
  withTransaction,
  type LedgerFields,
} from '@ibt/db';
import {
  AppError,
  LedgerResponseSchema,
  MeResponseSchema,
  UsageResponseSchema,
  microToUsdcString,
  usageRangeEndMs,
  type DepositResponse,
  type LedgerEntry,
  type LedgerResponse,
  type MeResponse,
  type PaginationQuery,
  type UsageQuery,
  type UsageResponse,
} from '@ibt/shared';

import type { AppContext } from '../../app.js';
import { isDuplicateKey } from '../../lib/mongoErrors.js';
import { toPublicKey } from '../../lib/publicKey.js';
import { cursorFilter, toPage } from '../../pagination.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_USAGE_DAYS = 30;

const REJECTION_MESSAGES: Record<DepositRejection, string> = {
  tx_not_found: 'transaction not found',
  not_finalized: 'transaction is not finalized',
  tx_failed: 'transaction failed on-chain',
  missing_memo: 'transaction has no memo',
  memo_mismatch: 'memo does not match depositRef',
  wrong_destination: 'no transfer to the treasury USDC account',
  wrong_mint: 'transfer is not USDC',
  zero_amount: 'transfer amount is zero',
  unsigned_transfer: 'transfer was not authorised by a transaction signer',
};

function treasuryAta(ctx: AppContext) {
  return ataOf(toPublicKey(ctx.env.TREASURY_WALLET), USDC_MINT[ctx.env.CLUSTER]);
}

async function loadUser(userId: string) {
  const user = await Users.findById(userId).lean();
  if (!user) throw new AppError('unauthorized', { message: 'user no longer exists' });
  return user;
}

async function recordRejection(
  ctx: AppContext,
  userId: Types.ObjectId,
  txSignature: string,
  reason: DepositRejection,
): Promise<void> {
  // Upsert: a signature that was rejected earlier keeps one row with the latest reason.
  await Deposits.updateOne(
    { txSignature, status: 'rejected' },
    {
      $set: { reason, verifiedAt: ctx.clock() },
      $setOnInsert: { userId, txSignature, amountMicroUsdc: 0n, slot: 0, status: 'rejected' },
    },
    { upsert: true },
  ).catch((err: unknown) => {
    // Lost a race with a credit of the same signature: the credited row wins.
    if (!isDuplicateKey(err)) throw err;
  });
  ctx.logger.warn({ userId: userId.toHexString(), txSignature, reason }, 'deposit rejected');
  ctx.alerts.recordRejectedDeposit();
}

/** Verifies a finalized USDC transfer to the treasury and credits it exactly once (L519). */
export async function submitDeposit(
  ctx: AppContext,
  userId: string,
  txSignature: string,
): Promise<DepositResponse> {
  const user = await loadUser(userId);
  const existing = await Deposits.findOne({ txSignature, status: 'credited' }).lean();
  if (existing) throw new AppError('deposit_already_credited');

  const result = await ctx.chain.verifyDeposit(txSignature, {
    treasuryAta: treasuryAta(ctx),
    depositRef: user.depositRef,
  });

  if (!result.ok) {
    // API-09: an unknown signature may simply not be indexed yet (or be random);
    // either way it is retryable and never recorded or alerted as a rejection.
    if (result.reason === 'tx_not_found') {
      throw new AppError('deposit_pending', {
        message: 'transaction not found yet; retry shortly',
      });
    }
    // Landed at `confirmed` but not yet `finalized`: retryable, and not a rejection.
    if (result.reason === 'not_finalized') {
      const status = await ctx.chain.signatureStatus(txSignature);
      if (status === 'landed' || status === 'pending') throw new AppError('deposit_pending');
    }
    await recordRejection(ctx, user._id, txSignature, result.reason);
    throw new AppError('deposit_invalid', { message: REJECTION_MESSAGES[result.reason] });
  }

  try {
    const balanceMicro = await withTransaction(async (session) => {
      await Deposits.deleteOne({ txSignature, status: 'rejected' }, { session });
      await Deposits.create(
        [
          {
            userId: user._id,
            txSignature,
            amountMicroUsdc: result.amountMicro,
            slot: result.slot,
            verifiedAt: ctx.clock(),
            status: 'credited',
          },
        ],
        { session },
      );
      const change = await credit(user._id, result.amountMicro, { txSignature }, { session });
      return change.balanceMicro;
    });
    ctx.logger.info(
      { userId, txSignature, amountMicro: result.amountMicro.toString() },
      'deposit credited',
    );
    return {
      credited: true,
      amountUsdc: microToUsdcString(result.amountMicro),
      balanceUsdc: microToUsdcString(balanceMicro),
    };
  } catch (err) {
    if (isDuplicateKey(err)) throw new AppError('deposit_already_credited', { cause: err });
    throw err;
  }
}

type LedgerRow = LedgerFields & { _id: Types.ObjectId; createdAt: Date };

function toLedgerEntry(row: LedgerRow): LedgerEntry {
  const ref = row.ref ?? {};
  return {
    id: row._id.toHexString(),
    type: row.type,
    ...(row.status ? { status: row.status } : {}),
    amountUsdc: microToUsdcString(row.amountMicroUsdc),
    balanceAfterUsdc:
      row.balanceAfterMicroUsdc === null || row.balanceAfterMicroUsdc === undefined
        ? null
        : microToUsdcString(row.balanceAfterMicroUsdc),
    ref: {
      ...(ref.txSignature ? { txSignature: ref.txSignature } : {}),
      ...(ref.requestId ? { requestId: ref.requestId } : {}),
      ...(ref.holdId ? { holdId: ref.holdId.toHexString() } : {}),
    },
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listLedger(userId: string, query: PaginationQuery): Promise<LedgerResponse> {
  const rows = await Ledger.find({
    userId: new Types.ObjectId(userId),
    ...cursorFilter(query.cursor),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean<LedgerRow[]>();
  const page = toPage(rows, query.limit);
  return LedgerResponseSchema.parse({
    items: page.rows.map(toLedgerEntry),
    nextCursor: page.nextCursor,
  });
}

/** A date-only `to` covers that whole UTC day. */
function usageRange(ctx: AppContext, query: UsageQuery): { from: Date; to: Date } {
  const to = query.to ? new Date(usageRangeEndMs(query.to)) : ctx.clock();
  const from = query.from
    ? new Date(Date.parse(query.from))
    : new Date(to.getTime() - DEFAULT_USAGE_DAYS * DAY_MS);
  return { from, to };
}

interface UsageAggregate {
  _id: { modelId: Types.ObjectId; date: string };
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cost: bigint | number;
}

/** Requests, tokens and cost per model per UTC day over `[from, to)`. */
export async function usage(
  ctx: AppContext,
  userId: string,
  query: UsageQuery,
): Promise<UsageResponse> {
  const { from, to } = usageRange(ctx, query);
  const rows = await Requests.aggregate<UsageAggregate>([
    { $match: { userId: new Types.ObjectId(userId), createdAt: { $gte: from, $lt: to } } },
    {
      $group: {
        _id: {
          modelId: '$modelId',
          date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
        },
        requests: { $sum: 1 },
        promptTokens: { $sum: '$promptTokens' },
        completionTokens: { $sum: '$completionTokens' },
        cost: { $sum: '$costMicroUsdc' },
      },
    },
    { $sort: { '_id.date': 1, '_id.modelId': 1 } },
  ]);
  const models = await Models.find({ _id: { $in: rows.map((row) => row._id.modelId) } })
    .select({ slug: 1 })
    .lean();
  const slugs = new Map(models.map((model) => [model._id.toHexString(), model.slug]));
  return UsageResponseSchema.parse({
    from: from.toISOString(),
    to: to.toISOString(),
    items: rows.map((row) => ({
      date: row._id.date,
      modelId: row._id.modelId.toHexString(),
      modelSlug: slugs.get(row._id.modelId.toHexString()) ?? 'unknown',
      requests: row.requests,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      costUsdc: microToUsdcString(BigInt(row.cost)),
    })),
  });
}

export async function me(userId: string): Promise<MeResponse> {
  const user = await loadUser(userId);
  return MeResponseSchema.parse({
    id: user._id.toHexString(),
    wallet: user.wallet,
    role: user.role,
    depositRef: user.depositRef,
    balanceUsdc: microToUsdcString(user.balanceMicroUsdc),
    heldUsdc: microToUsdcString(user.heldMicroUsdc),
    availableUsdc: microToUsdcString(user.balanceMicroUsdc - user.heldMicroUsdc),
    createdAt: user.createdAt.toISOString(),
  });
}
