import { Settlements, type ClientSession, type SettlementDoc } from '@ibt/db';

import type { KeeperCtx } from '../ctx.js';

/** The stored settlement no longer matches what this runner loaded; it must not write or send. */
export class SettlementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementConflictError';
  }
}

/** The keeper lease was lost or taken over by a newer epoch; the whole run stops. */
export class LeaseLostError extends SettlementConflictError {
  constructor() {
    super('keeper lease lost or taken over; no further sends from this run');
    this.name = 'LeaseLostError';
  }
}

const isDocumentNotFound = (err: unknown): boolean =>
  err instanceof Error && err.name === 'DocumentNotFoundError';

/** A conflict from this module, or a fenced `save()` that matched nothing; otherwise `null`. */
export function asConflict(err: unknown): SettlementConflictError | null {
  if (err instanceof SettlementConflictError) return err;
  if (isDocumentNotFound(err)) {
    return new SettlementConflictError('settlement was claimed by a newer lease epoch');
  }
  return null;
}

/** Throws `LeaseLostError` unless the lease is held in the epoch `settlement` was claimed with. */
export function assertLeaseHeld(ctx: KeeperCtx, settlement?: SettlementDoc): void {
  if (!ctx.lease) return;
  const epoch = ctx.lease.epoch();
  const sameTenure = settlement === undefined || epoch === settlement.leaseEpoch;
  if (!ctx.lease.isHeld() || epoch === null || !sameTenure) throw new LeaseLostError();
}

/** Every later `save()` of `settlement` only writes while its stored lease epoch is unchanged. */
export function fence(settlement: SettlementDoc): SettlementDoc {
  settlement.$where = { leaseEpoch: settlement.leaseEpoch ?? null };
  return settlement;
}

/**
 * Claims `settlement` for the run's lease epoch and fences it. A settlement already claimed
 * by a newer epoch belongs to that holder, so this one has lost the lease.
 */
export async function claimSettlement(
  ctx: KeeperCtx,
  settlement: SettlementDoc,
): Promise<SettlementDoc> {
  if (!ctx.lease) return fence(settlement);
  const epoch = ctx.lease.epoch();
  if (!ctx.lease.isHeld() || epoch === null) throw new LeaseLostError();
  const claimed = await Settlements.findOneAndUpdate(
    { _id: settlement._id, $or: [{ leaseEpoch: null }, { leaseEpoch: { $lte: epoch } }] },
    { $set: { leaseEpoch: epoch } },
    { new: true },
  );
  if (!claimed) throw new LeaseLostError();
  return fence(claimed);
}

/**
 * Paths `saveIf` saved per settlement in its current transaction. A transaction retried
 * after a transient commit error re-runs its callback on a document `save()` already
 * marked clean (KPR-01), so the retry re-marks these paths to write them again.
 */
const savedInTransaction = new WeakMap<
  SettlementDoc,
  { session: ClientSession; paths: Set<string> }
>();

function remarkRetriedPaths(settlement: SettlementDoc, session: ClientSession): void {
  const earlier = savedInTransaction.get(settlement);
  const paths = new Set(earlier?.session === session ? earlier.paths : []);
  for (const path of paths) settlement.markModified(path);
  for (const path of settlement.directModifiedPaths()) paths.add(path);
  savedInTransaction.set(settlement, { session, paths });
}

/**
 * Compare-and-set save: writes only if the stored settlement also matches `expected`
 * (stored values, before this save), else throws `SettlementConflictError` and writes nothing.
 *
 * With nothing to write, mongoose's `save()` only checks that the `_id` exists and skips
 * `$where`; the fence and `expected` are then asserted with an explicit fenced update
 * (it bumps `updatedAt`, so a concurrent writer still conflicts with this transaction).
 */
export async function saveIf(
  settlement: SettlementDoc,
  expected: Record<string, unknown>,
  session?: ClientSession,
): Promise<void> {
  if (session) remarkRetriedPaths(settlement, session);
  const fenced = settlement.$where;
  const where = { ...fenced, ...expected };
  const conflict = () =>
    new SettlementConflictError(
      `settlement ${settlement._id.toHexString()} changed under this runner (${Object.keys(expected).join(', ')})`,
    );

  if (!settlement.isModified()) {
    const { matchedCount } = await Settlements.updateOne(
      { ...where, _id: settlement._id },
      { $set: { updatedAt: new Date() } },
      session ? { session } : {},
    );
    if (matchedCount !== 1) throw conflict();
    return;
  }

  settlement.$where = where;
  try {
    await settlement.save(session ? { session } : {});
  } catch (err) {
    if (!isDocumentNotFound(err)) throw err;
    throw conflict();
  } finally {
    settlement.$where = fenced;
  }
}
