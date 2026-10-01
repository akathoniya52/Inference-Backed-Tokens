import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { connectDb, disconnectDb, mongoose } from '../src/index.js';

describe('@ibt/db', () => {
  beforeAll(async () => {
    await connectDb(inject('mongoUri'));
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it('connects to a writable single-node replica set (transactions need one)', async () => {
    const admin = mongoose.connection.db?.admin();
    expect(admin).toBeDefined();
    const hello = (await admin?.command({ hello: 1 })) as {
      isWritablePrimary?: boolean;
      setName?: string;
    };
    expect(hello.isWritablePrimary).toBe(true);
    expect(hello.setName).toBeTruthy();
  });

  it('round-trips a document inside a transaction', async () => {
    const Smoke = mongoose.model('Smoke', new mongoose.Schema({ n: Number }));
    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await Smoke.create([{ n: 1 }], { session });
    });
    await session.endSession();
    expect(await Smoke.countDocuments({ n: 1 })).toBe(1);
  });
});
