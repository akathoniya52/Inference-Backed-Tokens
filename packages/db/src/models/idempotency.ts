import { IDEMPOTENCY_TTL_MS } from '@ibt/shared';
import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const idempotencySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, required: true },
    requestHash: { type: String, required: true },
    /** Stored response; `null` while the first request is in flight. */
    response: { type: Schema.Types.Mixed, default: null },
    /**
     * In-flight lock: past this instant the claimer is presumed dead (crash, restart)
     * and the next request with the key may take the row over. `null` once completed.
     */
    lockedUntil: { type: Date, default: null },
  },
  {
    collection: 'idempotency',
    timestamps: { createdAt: true, updatedAt: false },
    autoIndex: false,
  },
);

idempotencySchema.index({ userId: 1, key: 1 }, { unique: true });
idempotencySchema.index({ createdAt: 1 }, { expireAfterSeconds: IDEMPOTENCY_TTL_MS / 1000 });

export type IdempotencyFields = InferSchemaType<typeof idempotencySchema>;
export type IdempotencyDoc = HydratedDocument<IdempotencyFields>;
export const Idempotency = model('Idempotency', idempotencySchema);

export interface ClaimIdempotencyOptions {
  /** How long the claim stays locked; must exceed the longest request it guards. */
  lockMs: number;
  now?: Date;
}

/** A held claim; `lockedUntil` fences `completeIdempotencyRow` / `releaseIdempotencyRow`. */
export interface IdempotencyLock {
  id: Types.ObjectId;
  lockedUntil: Date;
}

export type IdempotencyRowClaim =
  | ({ kind: 'claimed' } & IdempotencyLock)
  | { kind: 'in_progress' }
  | { kind: 'existing'; requestHash: string; response: unknown };

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}

/**
 * Claims `{userId, key}` for one in-flight request (GW-06). A fresh key inserts the row;
 * an in-flight row whose lock expired (its claimer died) is taken over with a CAS on
 * `{response: null, lockedUntil < now}`, so of several concurrent retries exactly one
 * wins. The takeover rebinds `requestHash` to the new body, since nothing was stored
 * for the old one. A completed row is returned for the caller to replay or reject.
 */
export async function claimIdempotencyRow(
  userId: Types.ObjectId | string,
  key: string,
  requestHash: string,
  { lockMs, now = new Date() }: ClaimIdempotencyOptions,
): Promise<IdempotencyRowClaim> {
  const owner = new Types.ObjectId(userId);
  const lockedUntil = new Date(now.getTime() + lockMs);
  try {
    const row = await Idempotency.create({ userId: owner, key, requestHash, lockedUntil });
    return { kind: 'claimed', id: row._id, lockedUntil };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }

  const taken = await Idempotency.findOneAndUpdate(
    // Rows written before `lockedUntil` existed have none; only their 24 h TTL frees them.
    { userId: owner, key, response: null, lockedUntil: { $type: 'date', $lt: now } },
    { $set: { requestHash, lockedUntil } },
    { new: true },
  );
  if (taken) return { kind: 'claimed', id: taken._id, lockedUntil };

  const existing = await Idempotency.findOne({ userId: owner, key }).lean();
  if (!existing || existing.response === null) return { kind: 'in_progress' };
  return { kind: 'existing', requestHash: existing.requestHash, response: existing.response };
}

/**
 * Stores the response and clears the lock, only while `lock` is still the row's
 * current claim. False when another request took the row over after the lock expired.
 */
export async function completeIdempotencyRow(
  lock: IdempotencyLock,
  response: unknown,
): Promise<boolean> {
  const { modifiedCount } = await Idempotency.updateOne(
    { _id: lock.id, response: null, lockedUntil: lock.lockedUntil },
    { $set: { response, lockedUntil: null } },
  );
  return modifiedCount === 1;
}

/** Deletes an in-flight row so the key can be retried, only while `lock` is still current. */
export async function releaseIdempotencyRow(lock: IdempotencyLock): Promise<boolean> {
  const { deletedCount } = await Idempotency.deleteOne({
    _id: lock.id,
    response: null,
    lockedUntil: lock.lockedUntil,
  });
  return deletedCount === 1;
}
