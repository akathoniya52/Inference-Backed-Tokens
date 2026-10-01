import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  ALL_MODELS,
  ApiKeys,
  Deposits,
  Idempotency,
  Leases,
  Ledger,
  Models,
  Nonces,
  PoolSnapshots,
  Requests,
  Settlements,
  Users,
  connectDb,
  disconnectDb,
  syncAllIndexes,
} from '../src/index.js';

interface IndexInfo {
  key: Record<string, number>;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
}

type IndexedModel = (typeof ALL_MODELS)[number];

interface Expected {
  model: IndexedModel;
  key: Record<string, number>;
  unique?: true;
  ttlSeconds?: number;
  partial?: Record<string, unknown>;
}

const DAY_S = 24 * 60 * 60;

const EXPECTED: readonly Expected[] = [
  { model: Users, key: { wallet: 1 }, unique: true },
  { model: Users, key: { depositRef: 1 }, unique: true },
  { model: ApiKeys, key: { keyHash: 1 }, unique: true },
  { model: ApiKeys, key: { userId: 1, createdAt: 1 } },
  { model: Models, key: { slug: 1 }, unique: true },
  {
    model: Models,
    key: { 'token.mint': 1 },
    unique: true,
    partial: { 'token.mint': { $type: 'string' } },
  },
  { model: Models, key: { providerId: 1 } },
  { model: Requests, key: { requestId: 1 }, unique: true },
  { model: Requests, key: { createdAt: 1 }, ttlSeconds: 90 * DAY_S },
  { model: Requests, key: { modelId: 1, settlementId: 1, createdAt: 1 } },
  { model: Requests, key: { userId: 1, createdAt: 1 } },
  {
    model: Requests,
    key: { userId: 1, idempotencyKey: 1 },
    partial: { idempotencyKey: { $type: 'string' } },
  },
  { model: Ledger, key: { userId: 1, createdAt: 1 } },
  { model: Ledger, key: { type: 1, status: 1, expiresAt: 1 } },
  { model: Deposits, key: { txSignature: 1 }, unique: true },
  { model: Settlements, key: { modelId: 1, periodStart: 1 }, unique: true },
  { model: Settlements, key: { state: 1, updatedAt: 1 } },
  { model: PoolSnapshots, key: { modelId: 1, ts: 1 } },
  { model: PoolSnapshots, key: { ts: 1 }, ttlSeconds: 30 * DAY_S },
  { model: Nonces, key: { expiresAt: 1 }, ttlSeconds: 0 },
  { model: Idempotency, key: { userId: 1, key: 1 }, unique: true },
  { model: Idempotency, key: { createdAt: 1 }, ttlSeconds: DAY_S },
  { model: Leases, key: { name: 1 }, unique: true },
  { model: Leases, key: { expiresAt: 1 }, ttlSeconds: 0 },
];

async function indexesOf(model: IndexedModel): Promise<IndexInfo[]> {
  return (await model.collection.indexes()) as IndexInfo[];
}

function sameKey(a: Record<string, number>, b: Record<string, number>): boolean {
  return JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));
}

describe('syncAllIndexes', () => {
  beforeAll(async () => {
    await connectDb(inject('mongoUri'));
    await syncAllIndexes();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it('disables autoIndex on every schema (G11)', () => {
    for (const model of ALL_MODELS) {
      expect(model.schema.get('autoIndex'), model.modelName).toBe(false);
    }
  });

  it.each(
    EXPECTED.map((e) => [`${e.model.collection.collectionName} ${JSON.stringify(e.key)}`, e]),
  )('%s', async (_name, expected) => {
    const found = (await indexesOf(expected.model)).find((ix) => sameKey(ix.key, expected.key));
    expect(found, 'index exists').toBeDefined();
    expect(found?.unique).toBe(expected.unique);
    expect(found?.sparse).toBeUndefined();
    expect(found?.expireAfterSeconds).toBe(expected.ttlSeconds);
    expect(found?.partialFilterExpression).toEqual(expected.partial);
  });

  it('creates no index beyond the plan list and _id', async () => {
    for (const model of ALL_MODELS) {
      const expectedKeys = EXPECTED.filter((e) => e.model === model).map((e) => e.key);
      const actual = (await indexesOf(model)).filter((ix) => !sameKey(ix.key, { _id: 1 }));
      expect(actual.map((ix) => ix.key)).toHaveLength(expectedKeys.length);
    }
  });

  it('is idempotent', async () => {
    await expect(syncAllIndexes()).resolves.toBeUndefined();
  });

  it('allows many models without a mint but rejects a duplicate mint', async () => {
    const base = {
      providerId: new Users()._id,
      name: 'm',
      upstream: { baseUrl: 'http://x', modelName: 'u', apiKeyEnc: 'k' },
      pricing: { inputPerMTokMicroUsdc: 1n, outputPerMTokMicroUsdc: 2n },
    };
    await Models.create([
      { ...base, slug: 'a' },
      { ...base, slug: 'b' },
    ]);
    await Models.create({ ...base, slug: 'c', token: { status: 'curve', mint: 'MINT' } });
    await expect(
      Models.create({ ...base, slug: 'd', token: { status: 'curve', mint: 'MINT' } }),
    ).rejects.toThrow(/duplicate key/);
    const stored = await Models.findOne({ slug: 'c' }).orFail();
    expect(stored.pricing.outputPerMTokMicroUsdc).toBe(2n);
    expect(stored.upstream.supportsStreamUsage).toBe(false);
    expect(stored.token.pendingCompoundLamports).toBe(0n);
    await Models.deleteMany({});
  });

  it('round-trips money as bigint in hydrated and lean reads', async () => {
    const big = 2n ** 60n;
    const user = await Users.create({ wallet: 'w', depositRef: 'REF00001', balanceMicroUsdc: big });
    expect((await Users.findById(user._id).orFail()).balanceMicroUsdc).toBe(big);
    expect((await Users.findById(user._id).lean().orFail()).balanceMicroUsdc).toBe(big);
    const key = await ApiKeys.create({ userId: user._id, keyHash: 'h', prefix: 'p', name: 'n' });
    expect(key.dailyCapMicroUsdc).toBe(50_000_000n);
    await Users.deleteMany({});
    await ApiKeys.deleteMany({});
  });
});
