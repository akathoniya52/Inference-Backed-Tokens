import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testDbUri } from './db-uri.js';

import { connectDb, disconnectDb, mongoose } from '../src/index.js';

describe('@ibt/db', () => {
  beforeAll(async () => {
    await connectDb(testDbUri('smoke'));
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

  it('runs queries with strictQuery on and sanitizeFilter off', async () => {
    expect(mongoose.get('strictQuery')).toBe(true);
    expect(mongoose.get('sanitizeFilter')).toBeFalsy();
    const Strict = mongoose.model('SmokeStrict', new mongoose.Schema({ n: Number }));
    await Strict.create([{ n: 1 }, { n: 2 }]);
    // Literal operators still work, and an unknown path never reaches Mongo.
    expect(await Strict.countDocuments({ n: { $gt: 1 } })).toBe(1);
    expect(Strict.find({ n: 1, notInSchema: 'x' }).cast()).toEqual({ n: 1 });
  });
});
