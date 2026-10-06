import mongoose, { type ClientSession } from 'mongoose';

/**
 * Runs `fn` in a transaction that the driver retries on transient errors (KPR-01).
 * Goes through mongoose's `connection.transaction()`, not the driver's
 * `session.withTransaction()`: when an attempt throws, mongoose restores the
 * modified paths of every document saved in it, so the retry's `save()` writes
 * them again instead of finding a clean document and writing nothing.
 *
 * A retry after a transient *commit* error re-runs `fn` without that reset; callers
 * that save fenced documents must not rely on dirty tracking alone (see the
 * keeper's `saveIf`).
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  return mongoose.connection.transaction(fn);
}
