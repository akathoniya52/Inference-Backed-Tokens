import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testDbUri } from './db-uri.js';

import {
  Idempotency,
  Types,
  claimIdempotencyRow,
  completeIdempotencyRow,
  connectDb,
  disconnectDb,
  releaseIdempotencyRow,
  syncAllIndexes,
} from '../src/index.js';

const LOCK_MS = 60_000;
const userId = new Types.ObjectId();
const t0 = new Date('2026-10-06T10:00:00Z');
const later = (ms: number) => new Date(t0.getTime() + ms);

describe('claimIdempotencyRow (GW-06)', () => {
  beforeAll(async () => {
    await connectDb(testDbUri('idempotency'));
    await syncAllIndexes();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  beforeEach(async () => {
    await Idempotency.deleteMany({});
  });

  it('claims a fresh key with a lock and reports an in-flight one as in progress', async () => {
    const claim = await claimIdempotencyRow(userId, 'k', 'h1', { lockMs: LOCK_MS, now: t0 });
    expect(claim).toMatchObject({ kind: 'claimed', lockedUntil: later(LOCK_MS) });
    const again = await claimIdempotencyRow(userId, 'k', 'h1', {
      lockMs: LOCK_MS,
      now: later(LOCK_MS - 1),
    });
    expect(again).toEqual({ kind: 'in_progress' });
  });

  it('takes over an expired in-flight lock exactly once under concurrency', async () => {
    await claimIdempotencyRow(userId, 'k', 'h1', { lockMs: LOCK_MS, now: t0 });
    const now = later(LOCK_MS + 1);

    const claims = await Promise.all(
      Array.from({ length: 10 }, () =>
        claimIdempotencyRow(userId, 'k', 'h2', { lockMs: LOCK_MS, now }),
      ),
    );

    expect(claims.filter((c) => c.kind === 'claimed')).toHaveLength(1);
    expect(claims.filter((c) => c.kind === 'in_progress')).toHaveLength(9);
    const row = await Idempotency.findOne({ userId, key: 'k' }).lean().orFail();
    expect(row.requestHash).toBe('h2');
    expect(row.lockedUntil?.getTime()).toBe(now.getTime() + LOCK_MS);
    expect(await Idempotency.countDocuments({})).toBe(1);
  });

  it('never takes over a completed row; it is returned for replay', async () => {
    const claim = await claimIdempotencyRow(userId, 'k', 'h1', { lockMs: LOCK_MS, now: t0 });
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    expect(await completeIdempotencyRow(claim, { status: 200 })).toBe(true);

    const replay = await claimIdempotencyRow(userId, 'k', 'h2', {
      lockMs: LOCK_MS,
      now: later(10 * LOCK_MS),
    });
    expect(replay).toEqual({ kind: 'existing', requestHash: 'h1', response: { status: 200 } });
    const row = await Idempotency.findOne({ userId, key: 'k' }).lean().orFail();
    expect(row.lockedUntil).toBeNull();
  });

  it('a claimer whose lock was taken over can neither complete nor release the row', async () => {
    const stale = await claimIdempotencyRow(userId, 'k', 'h1', { lockMs: LOCK_MS, now: t0 });
    const fresh = await claimIdempotencyRow(userId, 'k', 'h1', {
      lockMs: LOCK_MS,
      now: later(LOCK_MS + 1),
    });
    if (stale.kind !== 'claimed' || fresh.kind !== 'claimed') throw new Error('expected claims');

    expect(await completeIdempotencyRow(stale, { status: 500 })).toBe(false);
    expect(await releaseIdempotencyRow(stale)).toBe(false);
    expect(await Idempotency.countDocuments({ response: null })).toBe(1);

    expect(await releaseIdempotencyRow(fresh)).toBe(true);
    expect(await Idempotency.countDocuments({})).toBe(0);
  });

  it('leaves rows without lockedUntil (written before it existed) to the TTL', async () => {
    await Idempotency.collection.insertOne({
      userId,
      key: 'legacy',
      requestHash: 'h',
      response: null,
      createdAt: t0,
    });
    const claim = await claimIdempotencyRow(userId, 'legacy', 'h', {
      lockMs: LOCK_MS,
      now: later(10 * LOCK_MS),
    });
    expect(claim).toEqual({ kind: 'in_progress' });
  });
});
