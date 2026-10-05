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
 * Compare-and-set save: writes only if the stored settlement also matches `expected`
 * (stored values, before this save), else throws `SettlementConflictError` and writes nothing.
 */
export async function saveIf(
  settlement: SettlementDoc,
  expected: Record<string, unknown>,
  session?: ClientSession,
): Promise<void> {
  const fenced = settlement.$where;
  settlement.$where = { ...fenced, ...expected };
  try {
    await settlement.save(session ? { session } : {});
  } catch (err) {
    if (!isDocumentNotFound(err)) throw err;
    throw new SettlementConflictError(
      `settlement ${settlement._id.toHexString()} changed under this runner (${Object.keys(expected).join(', ')})`,
    );
  } finally {
    settlement.$where = fenced;
  }
}
