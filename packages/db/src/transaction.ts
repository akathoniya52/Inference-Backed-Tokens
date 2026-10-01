import mongoose, { type ClientSession } from 'mongoose';

/** Runs `fn` in a transaction that the driver retries on transient errors. */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => fn(session));
  } finally {
    await session.endSession();
  }
}
