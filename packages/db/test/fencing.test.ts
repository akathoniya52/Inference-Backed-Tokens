import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testDbUri } from './db-uri.js';

import {
  Leases,
  Settlements,
  Types,
  connectDb,
  disconnectDb,
  mongoose,
  startSession,
  syncAllIndexes,
  withTransaction,
} from '../src/index.js';

describe('fencing fields', () => {
  beforeAll(async () => {
    await connectDb(testDbUri('fencing'));
    // Transactions cannot create collections implicitly on every server version.
    await syncAllIndexes();
  });

  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase();
    await disconnectDb();
  });

  it('a lease starts at epoch 0', async () => {
    const lease = await Leases.create({ name: 'k', owner: 'a', expiresAt: new Date() });
    expect(lease.epoch).toBe(0);
  });

  it('a settlement starts unclaimed and with no payout reserved', async () => {
    const doc = await Settlements.create({
      modelId: new Types.ObjectId(),
      periodStart: new Date('2026-01-01T00:00:00Z'),
      periodEnd: new Date('2026-01-01T01:00:00Z'),
    });
    expect(doc.leaseEpoch).toBeNull();
    expect(doc.provider.reserved).toBe(false);
  });

  it('a save with $where writes nothing once the stored epoch moved on', async () => {
    const doc = await Settlements.create({
      modelId: new Types.ObjectId(),
      periodStart: new Date('2026-01-01T01:00:00Z'),
      periodEnd: new Date('2026-01-01T02:00:00Z'),
      leaseEpoch: 1,
    });
    doc.$where = { leaseEpoch: 1 };
    await Settlements.updateOne({ _id: doc._id }, { $set: { leaseEpoch: 2 } });
    doc.error = 'stale write';
    await expect(doc.save()).rejects.toThrow(/No document found/);
    expect((await Settlements.findById(doc._id).lean())?.error).toBeNull();
  });

  it('a retried withTransaction attempt writes a saved document again (KPR-01)', async () => {
    const doc = await Settlements.create({
      modelId: new Types.ObjectId(),
      periodStart: new Date('2026-01-01T02:00:00Z'),
      periodEnd: new Date('2026-01-01T03:00:00Z'),
      leaseEpoch: 1,
    });
    const lease = await Leases.create({ name: 'kpr01', owner: 'a', expiresAt: new Date() });

    // Another transaction holds an uncommitted write on the lease, so the first attempt's
    // write to it fails with a WriteConflict (TransientTransactionError) and is retried.
    const blocker = await startSession();
    blocker.startTransaction();
    await Leases.updateOne({ _id: lease._id }, { $set: { owner: 'b' } }, { session: blocker });

    let attempts = 0;
    await withTransaction(async (session) => {
      attempts += 1;
      doc.error = 'converted';
      doc.$where = { leaseEpoch: 1 };
      await doc.save({ session });
      try {
        await Leases.updateOne({ _id: lease._id }, { $inc: { epoch: 1 } }, { session });
      } catch (err) {
        if (attempts === 1) await blocker.abortTransaction();
        throw err;
      }
    });
    await blocker.endSession();

    expect(attempts).toBe(2);
    expect((await Leases.findById(lease._id).orFail()).epoch).toBe(1);
    // Without the reset, attempt 2 saved a clean document: no write, so this stayed null.
    expect((await Settlements.findById(doc._id).lean())?.error).toBe('converted');
  });
});
