import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testDbUri } from './db-uri.js';

import { Leases, Settlements, Types, connectDb, disconnectDb, mongoose } from '../src/index.js';

describe('fencing fields', () => {
  beforeAll(async () => {
    await connectDb(testDbUri('fencing'));
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
});
