import { AppError, HOLD_TTL_MS, microToUsdcString, type LedgerType } from '@ibt/shared';
import { Types, type ClientSession } from 'mongoose';

import { DailySpend } from './models/dailySpend.js';
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

export interface DailyCapOptions {
  apiKeyId: Id;
  /** Start of the UTC day the spend counts against. */
  day: Date;
  capMicro: bigint;
}

export interface HoldOptions {
  /** Unique across holds: a reused id fails with `invalid_request`. */
  requestId: string;
  expiresInMs?: number;
  /** G21: reserve the estimate against the key's daily cap in the same transaction. */
  dailyCap?: DailyCapOptions;
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

export interface AdjustOptions extends WriteOptions {
  /** Let a negative delta take spendable funds (`balance − held`) below zero. */
  allowNegative?: boolean;
}

export interface ReadOptions {
  /** Read inside the caller's transaction (one snapshot with its other reads). */
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

/** Takes `amountMicro` from the balance iff `balance − held ≥ amount`, atomically. */
async function debitSpendable(
  userId: Id,
  amountMicro: bigint,
  session: ClientSession,
): Promise<UserDoc> {
  const user = await Users.findOneAndUpdate(
    {
      _id: userId,
      $expr: {
        $gte: [{ $subtract: ['$balanceMicroUsdc', '$heldMicroUsdc'] }, amountMicro],
      },
    },
    { $inc: { balanceMicroUsdc: -amountMicro } },
    { new: true, session },
  );
  if (user) return user;
  const current = await Users.findById(userId, null, { session });
  if (!current) throw userNotFound(userId);
  const shortfall = amountMicro - (current.balanceMicroUsdc - current.heldMicroUsdc);
  throw new AppError('insufficient_credits', {
    details: { shortfallUsdc: microToUsdcString(shortfall) },
  });
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
  holdRow: LedgerDoc,
  record: RequestRecord,
  costMicro: bigint,
  session: ClientSession,
): Promise<void> {
  await Requests.create(
    [
      {
        ...record,
        userId: holdRow.userId,
        costMicroUsdc: costMicro,
        dailyCapDay: holdRow.dailyCap?.day ?? null,
      },
    ],
    { session },
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A `dailySpend` row outlives its day by more than any hold. */
const DAILY_SPEND_TTL_MS = 2 * DAY_MS;

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}

function dailyCapExceeded(capMicro: bigint): AppError {
  return new AppError('daily_cap_exceeded', {
    details: { dailyCapUsdc: microToUsdcString(capMicro) },
  });
}

/**
 * Creates the key's `dailySpend` row for the day if missing, seeded with the
 * spend already recorded in `requests` (rows written before the counter). A
 * request counts on the day its hold reserved against (DB-05): one held at 23:59
 * and captured after midnight was already counted on the earlier day's row.
 */
async function ensureDailySpend(userId: Id, cap: DailyCapOptions): Promise<void> {
  const apiKeyId = new Types.ObjectId(cap.apiKeyId);
  if (await DailySpend.exists({ apiKeyId, day: cap.day })) return;
  const dayEnd = new Date(cap.day.getTime() + DAY_MS);
  const [row] = await Requests.aggregate<{ spent: bigint | number }>([
    {
      $match: {
        userId: new Types.ObjectId(userId),
        createdAt: { $gte: cap.day },
        apiKeyId,
        $or: [{ dailyCapDay: cap.day }, { dailyCapDay: null, createdAt: { $lt: dayEnd } }],
      },
    },
    { $group: { _id: null, spent: { $sum: '$costMicroUsdc' } } },
  ]);
  try {
    await DailySpend.updateOne(
      { apiKeyId, day: cap.day },
      {
        $setOnInsert: {
          reservedMicroUsdc: row ? BigInt(row.spent) : 0n,
          expiresAt: new Date(cap.day.getTime() + DAILY_SPEND_TTL_MS),
        },
      },
      { upsert: true },
    );
  } catch (err) {
    // A concurrent first request of the day created the row first.
    if (!isDuplicateKey(err)) throw err;
  }
}

/** Adds `estimateMicro` to the day's reservation iff it stays within the cap. */
async function reserveDailyCap(
  cap: DailyCapOptions,
  estimateMicro: bigint,
  session: ClientSession,
): Promise<void> {
  const reserved = await DailySpend.findOneAndUpdate(
    {
      apiKeyId: new Types.ObjectId(cap.apiKeyId),
      day: cap.day,
      $expr: { $lte: [{ $add: ['$reservedMicroUsdc', estimateMicro] }, cap.capMicro] },
    },
    { $inc: { reservedMicroUsdc: estimateMicro } },
    { new: true, session },
  );
  if (!reserved) throw dailyCapExceeded(cap.capMicro);
}

/** Moves a closed hold's daily reservation by `delta`; no-op for uncapped holds. */
async function adjustDailyCap(
  holdRow: LedgerDoc,
  delta: bigint,
  session: ClientSession,
): Promise<void> {
  if (!holdRow.dailyCap || delta === 0n) return;
  await DailySpend.updateOne(
    { apiKeyId: holdRow.dailyCap.apiKeyId, day: holdRow.dailyCap.day },
    { $inc: { reservedMicroUsdc: delta } },
    { session },
  );
}

/**
 * Reserves `estimateMicro` iff `balance − held ≥ estimate` (G14) and, with
 * `dailyCap`, iff the key's day stays within its cap (G21), atomically. The
 * hold row claims `requestId`; a second hold for the same id is rejected.
 */
export async function hold(userId: Id, estimateMicro: bigint, options: HoldOptions): Promise<Hold> {
  assertPositive(estimateMicro, 'estimateMicro');
  const expiresInMs = options.expiresInMs ?? HOLD_TTL_MS;
  const { dailyCap } = options;
  if (dailyCap) {
    if (estimateMicro > dailyCap.capMicro) throw dailyCapExceeded(dailyCap.capMicro);
    await ensureDailySpend(userId, dailyCap);
  }

  try {
    return await withTransaction((session) =>
      openHoldRow(userId, estimateMicro, options, expiresInMs, session),
    );
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    throw new AppError('invalid_request', { message: 'X-Request-Id was already used' });
  }
}

async function openHoldRow(
  userId: Id,
  estimateMicro: bigint,
  options: HoldOptions,
  expiresInMs: number,
  session: ClientSession,
): Promise<Hold> {
  const { dailyCap } = options;
  if (dailyCap) await reserveDailyCap(dailyCap, estimateMicro, session);

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
      ...(dailyCap
        ? { dailyCap: { apiKeyId: new Types.ObjectId(dailyCap.apiKeyId), day: dailyCap.day } }
        : {}),
    },
    session,
  );
  return { holdId: entry._id, userId: user._id, estimateMicro, expiresAt };
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

    // DB-01: the hold is what `hold()` checked against spendable funds; billing past
    // it could overdraw. Throwing aborts the transaction, so the hold stays open.
    const estimateMicro = -closed.amountMicroUsdc;
    if (costMicro > estimateMicro) {
      throw new AppError('internal', {
        message: `capture of ${costMicro} exceeds hold ${String(holdId)} of ${estimateMicro}`,
      });
    }
    const user = await incUser(
      closed.userId,
      { balanceMicroUsdc: -costMicro, heldMicroUsdc: closed.amountMicroUsdc },
      session,
    );
    // The reservation shrinks from the estimate to the billed cost.
    await adjustDailyCap(closed, costMicro + closed.amountMicroUsdc, session);
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
    await insertRequest(closed, request, costMicro, session);
    return { alreadyCaptured: false, entry, balanceMicro: user.balanceMicroUsdc };
  });
}

async function closeHold(
  holdId: Id,
  status: 'released' | 'expired',
  request: RequestRecord | undefined,
  session: ClientSession,
): Promise<boolean> {
  // GW-12: a hold with a capture due is billed by hold expiry, never closed for free.
  const closed = await Ledger.findOneAndUpdate(
    { _id: holdId, type: 'hold', status: 'open', captureDueMicroUsdc: null },
    { $set: { status } },
    { new: true, session },
  );
  if (!closed) return false;

  const estimateMicro = -closed.amountMicroUsdc;
  const user = await incUser(closed.userId, { heldMicroUsdc: -estimateMicro }, session);
  await adjustDailyCap(closed, -estimateMicro, session);
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
  if (request) await insertRequest(closed, request, 0n, session);
  return true;
}

/** Releases an open hold without billing; optionally records the failed request. No-op otherwise. */
export async function release(holdId: Id, request?: RequestRecord): Promise<ReleaseResult> {
  const released = await withTransaction((session) =>
    closeHold(holdId, 'released', request, session),
  );
  return { released };
}

/**
 * GW-05: true once the hold is closed without a charge (released or expired),
 * so its call was never billed and never will be.
 */
export async function isHoldUnbilled(holdId: Id): Promise<boolean> {
  const row = await Ledger.findOne({ _id: holdId, type: 'hold' }, { status: 1 }).lean();
  return row?.status === 'released' || row?.status === 'expired';
}

/**
 * GW-12: records on a still open hold the cost of a delivered call whose
 * capture failed, so hold expiry captures it instead of releasing it. False
 * when the hold is no longer open (captured or closed meanwhile).
 */
export async function markCaptureDue(
  holdId: Id,
  costMicro: bigint,
  request: RequestRecord,
): Promise<boolean> {
  if (costMicro < 0n) throw new RangeError(`costMicro must be >= 0, got ${costMicro}`);
  const { modifiedCount } = await Ledger.updateOne(
    {
      _id: holdId,
      type: 'hold',
      status: 'open',
      // The capture guard (DB-01): never more than the hold reserved.
      amountMicroUsdc: { $lte: -costMicro },
    },
    { $set: { captureDueMicroUsdc: costMicro, captureDueRequest: request } },
  );
  return modifiedCount === 1;
}

export interface DueCapture {
  holdId: Types.ObjectId;
  costMicro: bigint;
  request: RequestRecord;
}

/** Open holds past `expiresAt` that carry a due capture (GW-12). */
export async function findDueCaptures(now: Date = new Date()): Promise<DueCapture[]> {
  const rows = await Ledger.find({
    type: 'hold',
    status: 'open',
    expiresAt: { $lte: now },
    captureDueMicroUsdc: { $ne: null },
  }).lean();
  const due: DueCapture[] = [];
  for (const row of rows) {
    const request = row.captureDueRequest;
    if (row.captureDueMicroUsdc == null || !request) continue;
    due.push({
      holdId: row._id,
      costMicro: row.captureDueMicroUsdc,
      request: {
        requestId: request.requestId,
        apiKeyId: request.apiKeyId,
        modelId: request.modelId,
        status: request.status,
        ...(request.idempotencyKey == null ? {} : { idempotencyKey: request.idempotencyKey }),
        promptTokens: request.promptTokens,
        completionTokens: request.completionTokens,
        ...(request.usageEstimated == null ? {} : { usageEstimated: request.usageEstimated }),
        ...(request.discountBps == null ? {} : { discountBps: request.discountBps }),
        latencyMs: request.latencyMs,
        streamed: request.streamed,
        upstreamStatus: request.upstreamStatus ?? null,
      },
    });
  }
  return due;
}

/**
 * Releases every open hold whose `expiresAt` is at or before `now`; returns how
 * many. Holds with a due capture are left to `findDueCaptures` and `capture`.
 */
export async function expireHolds(now: Date = new Date()): Promise<number> {
  const stale = await Ledger.find(
    { type: 'hold', status: 'open', expiresAt: { $lte: now }, captureDueMicroUsdc: null },
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

/**
 * Moves the balance by a signed delta. A negative delta is refused with
 * `insufficient_credits` when it would take spendable funds (`balance − held`)
 * below zero (DB-02), checked atomically with the update, unless `allowNegative`.
 */
export async function adjust(
  userId: Id,
  deltaMicro: bigint,
  reason: string,
  options: AdjustOptions = {},
): Promise<BalanceChange> {
  if (deltaMicro === 0n) throw new RangeError('deltaMicro must be non-zero');
  const floored = deltaMicro < 0n && !options.allowNegative;

  return inSession(options.session, async (session) => {
    const user = floored
      ? await debitSpendable(userId, -deltaMicro, session)
      : await incUser(userId, { balanceMicroUsdc: deltaMicro }, session);
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

async function sumLedger(match: Record<string, unknown>, options: ReadOptions): Promise<bigint> {
  const [row] = await Ledger.aggregate<{ total: bigint | number }>([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$amountMicroUsdc' } } },
  ]).session(options.session ?? null);
  if (!row) return 0n;
  return typeof row.total === 'bigint' ? row.total : BigInt(row.total);
}

/** Balance implied by the ledger (L372): deposits + adjustments − captures. */
export async function recomputeBalance(userId: Id, options: ReadOptions = {}): Promise<bigint> {
  return sumLedger(
    { userId: new Types.ObjectId(userId), type: { $in: [...BALANCE_LEDGER_TYPES] } },
    options,
  );
}

/** Held amount implied by the ledger (KPR-07): the estimates of the user's open holds. */
export async function recomputeHeld(userId: Id, options: ReadOptions = {}): Promise<bigint> {
  const open = await sumLedger(
    { userId: new Types.ObjectId(userId), type: 'hold', status: 'open' },
    options,
  );
  return -open;
}
