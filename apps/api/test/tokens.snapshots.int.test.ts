import { Models, PoolSnapshots, Types } from '@ibt/db';
import { TokenSnapshotsResponseSchema } from '@ibt/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorOf, makeTestApp, newWallet, type TestApp } from './helpers.js';

const address = () => newWallet().wallet;

describe('tokens: snapshots price series', () => {
  let t: TestApp;
  const mint = address();
  const emptyMint = address();
  const pool = address();
  const base = new Date('2026-10-02T12:00:00Z').getTime();

  async function seedModel(slug: string, tokenMint: string, dbcPool: string) {
    const doc = await Models.create({
      providerId: new Types.ObjectId(),
      slug,
      name: slug,
      upstream: { baseUrl: 'http://127.0.0.1:1/v1', modelName: 'm', apiKeyEnc: 'enc' },
      pricing: { inputPerMTokMicroUsdc: 1n, outputPerMTokMicroUsdc: 1n },
      token: { status: 'curve', mint: tokenMint, dbcPool },
    });
    return doc._id;
  }

  beforeAll(async () => {
    t = await makeTestApp();
    const modelId = await seedModel('snap-curve', mint, pool);
    await seedModel('snap-empty', emptyMint, address());
    const snapshot = (minute: number, price: number, progress: number, isMigrated = false) => ({
      modelId,
      pool,
      ts: new Date(base + minute * 60_000),
      quoteReserve: '1',
      baseReserve: '1',
      sqrtPrice: '1',
      progress,
      priceSolPerToken: price,
      isMigrated,
    });
    // Inserted out of order so the response ordering comes from `ts`, not insertion.
    await PoolSnapshots.create([
      snapshot(2, 1e-8, 1, true),
      snapshot(0, 1e-9, 0.1),
      snapshot(1, 6.1e-9, 0.42),
    ]);
  });

  afterAll(async () => {
    await t.close();
  });

  it('returns every point oldest first in the shared shape', async () => {
    const res = await request(t.app).get(`/api/tokens/${mint}/snapshots`);
    expect(res.status).toBe(200);
    expect(TokenSnapshotsResponseSchema.parse(res.body)).toEqual({
      mint,
      points: [
        {
          ts: '2026-10-02T12:00:00.000Z',
          priceSolPerToken: '0.000000001',
          progress: 0.1,
          phase: 'curve',
        },
        {
          ts: '2026-10-02T12:01:00.000Z',
          priceSolPerToken: '0.0000000061',
          progress: 0.42,
          phase: 'curve',
        },
        {
          ts: '2026-10-02T12:02:00.000Z',
          priceSolPerToken: '0.00000001',
          progress: 1,
          phase: 'graduated',
        },
      ],
    });
  });

  it('limit keeps the most recent points, still oldest first', async () => {
    const res = await request(t.app).get(`/api/tokens/${mint}/snapshots?limit=2`);
    expect(res.status).toBe(200);
    const body = TokenSnapshotsResponseSchema.parse(res.body);
    expect(body.points.map((p) => p.ts)).toEqual([
      '2026-10-02T12:01:00.000Z',
      '2026-10-02T12:02:00.000Z',
    ]);
  });

  it('validates limit to 1..1000', async () => {
    for (const limit of ['0', '1001', 'abc', '1.5']) {
      const res = await request(t.app).get(`/api/tokens/${mint}/snapshots?limit=${limit}`);
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('invalid_request');
    }
    const max = await request(t.app).get(`/api/tokens/${mint}/snapshots?limit=1000`);
    expect(max.status).toBe(200);
  });

  it('a token without snapshots returns an empty series', async () => {
    const res = await request(t.app).get(`/api/tokens/${emptyMint}/snapshots`);
    expect(res.status).toBe(200);
    expect(TokenSnapshotsResponseSchema.parse(res.body)).toEqual({ mint: emptyMint, points: [] });
  });

  it('unknown mint → 404 not_found, malformed mint → 400', async () => {
    const unknown = await request(t.app).get(`/api/tokens/${address()}/snapshots`);
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown).code).toBe('not_found');
    const bad = await request(t.app).get('/api/tokens/not-a-mint/snapshots');
    expect(bad.status).toBe(400);
  });
});
