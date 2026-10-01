import { AppError, HOLD_TTL_MS, microToUsdcString, type LedgerType } from '@ibt/shared';
import { Types, type ClientSession } from 'mongoose';

import { Ledger, type LedgerDoc } from './models/ledger.js';
import { Requests, type RequestStatus } from './models/requests.js';
import { Users, type UserDoc } from './models/users.js';
import { withTransaction } from './transaction.js';

type Id = Types.ObjectId | string;

/** Ledger types that move `users.balanceMicroUsdc` (holds and releases only move `held`). */
export const BALANCE_LEDGER_TYPES = Object.freeze([
  'deposit',
  'capture',
  'adjust',
] as const satisfies readonly LedgerType[]);

export interface HoldOptions {
  requestId: string;
  expiresInMs?: number;
}

export interface Hold {
  holdId: Types.ObjectId;
  userId: Types.ObjectId;
  estimateMicro: bigint;
  expiresAt: Date;
}

/** Request document fields supplied by the gateway; `userId` and the cost come from the hold. */
export interface RequestRecord {
  requestId: string;
  apiKeyId: Id;
  modelId: Id;
  status: RequestStatus;
  idempotencyKey?: string;
  promptTokens: number;
  completionTokens: number;
  usageEstimated?: boolean;
  discountBps?: number;
  latencyMs: number;
  streamed: boolean;
  upstreamStatus?: number | null;
}

export interface CaptureResult {
  /** True when the hold had already been captured; nothing was written. */
  alreadyCaptured: boolean;
  entry: LedgerDoc;
  balanceMicro: bigint;
}

export interface ReleaseResult {
  released: boolean;
}

export interface BalanceChange {
  entry: LedgerDoc;
  balanceMicro: bigint;
}

export type CreditRef = { txSignature: string } | { settlementId: Id };

export interface WriteOptions {
  /** Join the caller's transaction instead of opening one. */
  session?: ClientSession;
}

function assertPositive(amount: bigint, name: string): void {
  if (amount <= 0n) throw new RangeError(`${name} must be > 0, got ${amount}`);
}

function userNotFound(userId: Id): AppError {
  return new AppError('not_found', { message: `user ${String(userId)} not found` });
}

function inSession<T>(
  session: ClientSession | undefined,
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  return session ? fn(session) : withTransaction(fn);
}

async function incUser(
  userId: Id,
  inc: { balanceMicroUsdc?: bigint; heldMicroUsdc?: bigint },
  session: ClientSession,
): Promise<UserDoc> {
  const user = await Users.findOneAndUpdate({ _id: userId }, { $inc: inc }, { new: true, session });
  if (!user) throw userNotFound(userId);
  return user;
}

async function insertEntry(
  fields: Record<string, unknown>,
  session: ClientSession,
): Promise<LedgerDoc> {
  const [entry] = await Ledger.create([fields], { session });
  if (!entry) throw new Error('ledger insert returned no document');
  return entry;
}

async function insertRequest(
  userId: Types.ObjectId,
  record: RequestRecord,
  costMicro: bigint,
  session: ClientSession,
): Promise<void> {
  await Requests.create([{ ...record, userId, costMicroUsdc: costMicro }], { session });
}

/** Reserves `estimateMicro` iff `balance − held ≥ estimate` (G14), atomically. */
export async function hold(userId: Id, estimateMicro: bigint, options: HoldOptions): Promise<Hold> {
  assertPositive(estimateMicro, 'estimateMicro');
  const expiresInMs = options.expiresInMs ?? HOLD_TTL_MS;

  return withTransaction(async (session) => {
    const user = await Users.findOneAndUpdate(
      {
        _id: userId,
        $expr: {
          $gte: [{ $subtract: ['$balanceMicroUsdc', '$heldMicroUsdc'] }, estimateMicro],
        },
      },
      { $inc: { heldMicroUsdc: estimateMicro } },
      { new: true, session },
    );
    if (!user) {
      const current = await Users.findById(userId, null, { session });
      if (!current) throw userNotFound(userId);
      const shortfall = estimateMicro - (current.balanceMicroUsdc - current.heldMicroUsdc);
      throw new AppError('insufficient_credits', {
        details: { shortfallUsdc: microToUsdcString(shortfall) },
      });
    }

    const expiresAt = new Date(Date.now() + expiresInMs);
    const entry = await insertEntry(
      {
        userId: user._id,
        type: 'hold',
        status: 'open',
        amountMicroUsdc: -estimateMicro,
        ref: { requestId: options.requestId },
        balanceAfterMicroUsdc: user.balanceMicroUsdc,
        expiresAt,
      },
      session,
    );
    return { holdId: entry._id, userId: user._id, estimateMicro, expiresAt };
  });
}

async function findHold(holdId: Id, session: ClientSession): Promise<LedgerDoc> {
  const existing = await Ledger.findOne({ _id: holdId, type: 'hold' }, null, { session });
  if (!existing) throw new AppError('not_found', { message: `hold ${String(holdId)} not found` });
  return existing;
}

/**
 * Bills `costMicro` against an open hold and records the request. Capturing an
 * already captured hold is a no-op that returns the original capture row.
 */
export async function capture(
  holdId: Id,
  costMicro: bigint,
  request: RequestRecord,
): Promise<CaptureResult> {
  if (costMicro < 0n) throw new RangeError(`costMicro must be >= 0, got ${costMicro}`);

  return withTransaction(async (session) => {
    const closed = await Ledger.findOneAndUpdate(
      { _id: holdId, type: 'hold', status: 'open' },
      { $set: { status: 'captured' } },
      { new: true, session },
    );

    if (!closed) {
      const existing = await findHold(holdId, session);
      if (existing.status !== 'captured') {
        throw new AppError('internal', {
          message: `hold ${String(holdId)} is ${existing.status ?? 'unknown'}`,
        });
      }
      const entry = await Ledger.findOne({ type: 'capture', 'ref.holdId': existing._id }, null, {
        session,
      });
      const user = await Users.findById(existing.userId, null, { session });
      if (!entry || !user) throw new Error(`capture of hold ${String(holdId)} is inconsistent`);
      return { alreadyCaptured: true, entry, balanceMicro: user.balanceMicroUsdc };
    }

    const user = await incUser(
      closed.userId,
      { balanceMicroUsdc: -costMicro, heldMicroUsdc: closed.amountMicroUsdc },
      session,
    );
    const entry = await insertEntry(
      {
        userId: user._id,
        type: 'capture',
        amountMicroUsdc: -costMicro,
        ref: { requestId: request.requestId, holdId: closed._id },
        balanceAfterMicroUsdc: user.balanceMicroUsdc,
      },
      session,
    );
    await insertRequest(user._id, request, costMicro, session);
    return { alreadyCaptured: false, entry, balanceMicro: user.balanceMicroUsdc };
  });
}

async function closeHold(
  holdId: Id,
  status: 'released' | 'expired',
  request: RequestRecord | undefined,
  session: ClientSession,
): Promise<boolean> {
  const closed = await Ledger.findOneAndUpdate(
    { _id: holdId, type: 'hold', status: 'open' },
    { $set: { status } },
    { new: true, session },
  );
  if (!closed) return false;

  const estimateMicro = -closed.amountMicroUsdc;
  const user = await incUser(closed.userId, { heldMicroUsdc: -estimateMicro }, session);
  await insertEntry(
    {
      userId: user._id,
      type: 'release',
      amountMicroUsdc: estimateMicro,
      ref: {
        holdId: closed._id,
        ...(closed.ref.requestId ? { requestId: closed.ref.requestId } : {}),
      },
      balanceAfterMicroUsdc: user.balanceMicroUsdc,
    },
    session,
  );
  if (request) await insertRequest(user._id, request, 0n, session);
  return true;
}

/** Releases an open hold without billing; optionally records the failed request. No-op otherwise. */
export async function release(holdId: Id, request?: RequestRecord): Promise<ReleaseResult> {
  const released = await withTransaction((session) =>
    closeHold(holdId, 'released', request, session),
  );
  return { released };
}

/** Releases every open hold whose `expiresAt` is at or before `now`; returns how many. */
export async function expireHolds(now: Date = new Date()): Promise<number> {
  const stale = await Ledger.find(
    { type: 'hold', status: 'open', expiresAt: { $lte: now } },
    { _id: 1 },
  ).lean();
  let expired = 0;
  for (const { _id } of stale) {
    if (await withTransaction((session) => closeHold(_id, 'expired', undefined, session))) {
      expired += 1;
    }
  }
  return expired;
}

/** Adds funds: a verified deposit (`txSignature`) or a settlement credit (`settlementId`). */
export async function credit(
  userId: Id,
  amountMicro: bigint,
  ref: CreditRef,
  options: WriteOptions = {},
): Promise<BalanceChange> {
  assertPositive(amountMicro, 'amountMicro');
  const isDeposit = 'txSignature' in ref;

  return inSession(options.session, async (session) => {
    const user = await incUser(userId, { balanceMicroUsdc: amountMicro }, session);
    const entry = await insertEntry(
      {
        userId: user._id,
        type: isDeposit ? 'deposit' : 'adjust',
        amountMicroUsdc: amountMicro,
        ref: isDeposit
          ? { txSignature: ref.txSignature }
          : { settlementId: new Types.ObjectId(ref.settlementId) },
        ...(isDeposit ? {} : { reason: 'settlement' }),
        balanceAfterMicroUsdc: user.balanceMicroUsdc,
      },
      session,
    );
    return { entry, balanceMicro: user.balanceMicroUsdc };
  });
}

export async function adjust(
  userId: Id,
  deltaMicro: bigint,
  reason: string,
  options: WriteOptions = {},
): Promise<BalanceChange> {
  if (deltaMicro === 0n) throw new RangeError('deltaMicro must be non-zero');

  return inSession(options.session, async (session) => {
    const user = await incUser(userId, { balanceMicroUsdc: deltaMicro }, session);
    const entry = await insertEntry(
      {
        userId: user._id,
        type: 'adjust',
        amountMicroUsdc: deltaMicro,
        reason,
        balanceAfterMicroUsdc: user.balanceMicroUsdc,
      },
      session,
    );
    return { entry, balanceMicro: user.balanceMicroUsdc };
  });
}

/** Balance implied by the ledger (L372): deposits + adjustments − captures. */
export async function recomputeBalance(userId: Id): Promise<bigint> {
  const [row] = await Ledger.aggregate<{ total: bigint | number }>([
    {
      $match: {
        userId: new Types.ObjectId(userId),
        type: { $in: [...BALANCE_LEDGER_TYPES] },
      },
    },
    { $group: { _id: null, total: { $sum: '$amountMicroUsdc' } } },
  ]);
  if (!row) return 0n;
  return typeof row.total === 'bigint' ? row.total : BigInt(row.total);
}
