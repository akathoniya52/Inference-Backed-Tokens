import { HOLD_TTL_MS, isAppError } from '@ibt/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testDbUri } from './db-uri.js';

import {
  ALL_MODELS,
  Ledger,
  Requests,
  Types,
  Users,
  adjust,
  capture,
  connectDb,
  credit,
  disconnectDb,
  expireHolds,
  hold,
  recomputeBalance,
  release,
  syncAllIndexes,
  type RequestRecord,
} from '../src/index.js';

const USDC = 1_000_000n;
const SIG = 'S'.repeat(88);

let seq = 0;

async function newUser(balance = 0n): Promise<Types.ObjectId> {
  seq += 1;
  const user = await Users.create({
    wallet: `wallet${seq}`,
    depositRef: `REF${String(seq).padStart(5, '0')}`,
  });
  if (balance > 0n) await credit(user._id, balance, { txSignature: `${SIG}${seq}` });
  return user._id;
}

function requestRecord(requestId: string): RequestRecord {
  return {
    requestId,
    apiKeyId: new Types.ObjectId(),
    modelId: new Types.ObjectId(),
    status: 'success',
    promptTokens: 10,
    completionTokens: 20,
    latencyMs: 123,
    streamed: false,
    upstreamStatus: 200,
  };
}

async function balances(userId: Types.ObjectId): Promise<{ balance: bigint; held: bigint }> {
  const user = await Users.findById(userId).orFail();
  return { balance: user.balanceMicroUsdc, held: user.heldMicroUsdc };
}

describe('ledger service', () => {
  beforeAll(async () => {
    await connectDb(testDbUri('ledger'));
    await syncAllIndexes();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  beforeEach(async () => {
    for (const model of ALL_MODELS) await model.collection.deleteMany({});
  });

  describe('hold', () => {
    it('reserves the estimate and writes an open hold row that expires in 10 min', async () => {
      const userId = await newUser(5n * USDC);
      const before = Date.now();
      const h = await hold(userId, 2n * USDC, { requestId: 'r1' });

      expect(await balances(userId)).toEqual({ balance: 5n * USDC, held: 2n * USDC });
      const row = await Ledger.findById(h.holdId).orFail();
      expect(row.type).toBe('hold');
      expect(row.status).toBe('open');
      expect(row.amountMicroUsdc).toBe(-2n * USDC);
      expect(row.ref.requestId).toBe('r1');
      expect(row.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + HOLD_TTL_MS);
      expect(h.expiresAt.getTime()).toBe(row.expiresAt?.getTime());
    });

    it('rejects with 402 insufficient_credits and the shortfall when spendable is too low', async () => {
      const userId = await newUser(3n * USDC);
      await hold(userId, 2n * USDC, { requestId: 'r1' });

      const err: unknown = await hold(userId, 1_500_000n, { requestId: 'r2' }).catch(
        (e: unknown) => e,
      );
      expect(isAppError(err)).toBe(true);
      if (!isAppError(err)) return;
      expect(err.code).toBe('insufficient_credits');
      expect(err.httpStatus).toBe(402);
      expect(err.details.shortfallUsdc).toBe('0.500000');
      expect(await balances(userId)).toEqual({ balance: 3n * USDC, held: 2n * USDC });
      expect(await Ledger.countDocuments({ type: 'hold' })).toBe(1);
    });

    it('rejects a non-positive estimate', async () => {
      const userId = await newUser(USDC);
      await expect(hold(userId, 0n, { requestId: 'r' })).rejects.toThrow(RangeError);
    });

    it('50 concurrent holds against 10 holds of balance: exactly 10 succeed, never overdrawn', async () => {
      const estimate = 300_000n;
      const userId = await newUser(10n * estimate);

      const results = await Promise.allSettled(
        Array.from({ length: 50 }, (_, i) => hold(userId, estimate, { requestId: `c${i}` })),
      );

      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(10);
      for (const f of failed) {
        expect(isAppError(f.reason) && f.reason.code).toBe('insufficient_credits');
      }
      const { balance, held } = await balances(userId);
      expect(held).toBe(10n * estimate);
      expect(balance - held).toBeGreaterThanOrEqual(0n);
      expect(await Ledger.countDocuments({ type: 'hold', status: 'open' })).toBe(10);
    }, 60_000);
  });

  describe('capture', () => {
    it('closes the hold, bills the cost, writes the capture row and inserts the request', async () => {
      const userId = await newUser(5n * USDC);
      const h = await hold(userId, 2n * USDC, { requestId: 'r1' });

      const result = await capture(h.holdId, 700_000n, requestRecord('r1'));

      expect(result.alreadyCaptured).toBe(false);
      expect(result.balanceMicro).toBe(4_300_000n);
      expect(await balances(userId)).toEqual({ balance: 4_300_000n, held: 0n });
      expect((await Ledger.findById(h.holdId).orFail()).status).toBe('captured');

      const row = await Ledger.findOne({ type: 'capture' }).orFail();
      expect(row._id.equals(result.entry._id)).toBe(true);
      expect(row.amountMicroUsdc).toBe(-700_000n);
      expect(row.balanceAfterMicroUsdc).toBe(4_300_000n);
      expect(row.ref.holdId?.equals(h.holdId)).toBe(true);
      expect(row.ref.requestId).toBe('r1');

      const request = await Requests.findOne({ requestId: 'r1' }).orFail();
      expect(request.userId.equals(userId)).toBe(true);
      expect(request.costMicroUsdc).toBe(700_000n);
      expect(request.status).toBe('success');
      expect(request.settlementId).toBeNull();
    });

    it('double capture is a no-op that returns the existing capture', async () => {
      const userId = await newUser(5n * USDC);
      const h = await hold(userId, 2n * USDC, { requestId: 'r1' });

      const first = await capture(h.holdId, 700_000n, requestRecord('r1'));
      const second = await capture(h.holdId, 900_000n, requestRecord('r1'));

      expect(second.alreadyCaptured).toBe(true);
      expect(second.entry._id.equals(first.entry._id)).toBe(true);
      expect(second.balanceMicro).toBe(4_300_000n);
      expect(await balances(userId)).toEqual({ balance: 4_300_000n, held: 0n });
      expect(await Ledger.countDocuments({ type: 'capture' })).toBe(1);
      expect(await Requests.countDocuments({})).toBe(1);
    });

    it('concurrent double capture bills once', async () => {
      const userId = await newUser(5n * USDC);
      const h = await hold(userId, 2n * USDC, { requestId: 'r1' });

      const results = await Promise.all([
        capture(h.holdId, 700_000n, requestRecord('r1')),
        capture(h.holdId, 700_000n, requestRecord('r1')),
      ]);

      expect(results.filter((r) => r.alreadyCaptured)).toHaveLength(1);
      expect(await balances(userId)).toEqual({ balance: 4_300_000n, held: 0n });
      expect(await Ledger.countDocuments({ type: 'capture' })).toBe(1);
    });

    it('refuses to capture a released hold', async () => {
      const userId = await newUser(5n * USDC);
      const h = await hold(userId, 2n * USDC, { requestId: 'r1' });
      await release(h.holdId);

      await expect(capture(h.holdId, 1n, requestRecord('r1'))).rejects.toThrow(/released/);
      expect(await balances(userId)).toEqual({ balance: 5n * USDC, held: 0n });
    });

    it('rejects an unknown hold with not_found', async () => {
      const err: unknown = await capture(new Types.ObjectId(), 1n, requestRecord('x')).catch(
        (e: unknown) => e,
      );
      expect(isAppError(err) && err.code).toBe('not_found');
    });
  });

  describe('release', () => {
    it('returns the held amount, writes a release row and records the failed request', async () => {
      const userId = await newUser(5n * USDC);
      const h = await hold(userId, 2n * USDC, { requestId: 'r1' });

      const result = await release(h.holdId, { ...requestRecord('r1'), status: 'upstream_error' });

      expect(result.released).toBe(true);
      expect(await balances(userId)).toEqual({ balance: 5n * USDC, held: 0n });
      expect((await Ledger.findById(h.holdId).orFail()).status).toBe('released');
      const row = await Ledger.findOne({ type: 'release' }).orFail();
      expect(row.amountMicroUsdc).toBe(2n * USDC);
      expect(row.balanceAfterMicroUsdc).toBe(5n * USDC);
      expect(row.ref.holdId?.equals(h.holdId)).toBe(true);
      const request = await Requests.findOne({ requestId: 'r1' }).orFail();
      expect(request.status).toBe('upstream_error');
      expect(request.costMicroUsdc).toBe(0n);
    });

    it('is a no-op on a hold that is no longer open', async () => {
      const userId = await newUser(5n * USDC);
      const h = await hold(userId, 2n * USDC, { requestId: 'r1' });
      await capture(h.holdId, 1_000_000n, requestRecord('r1'));

      expect((await release(h.holdId)).released).toBe(false);
      expect(await balances(userId)).toEqual({ balance: 4n * USDC, held: 0n });
      expect(await Ledger.countDocuments({ type: 'release' })).toBe(0);

      const h2 = await hold(userId, USDC, { requestId: 'r2' });
      expect((await release(h2.holdId)).released).toBe(true);
      expect((await release(h2.holdId)).released).toBe(false);
      expect(await balances(userId)).toEqual({ balance: 4n * USDC, held: 0n });
    });
  });

  describe('expireHolds', () => {
    it('expires only open holds past expiresAt and returns their count', async () => {
      const userId = await newUser(10n * USDC);
      const now = Date.now();
      const stale = await hold(userId, USDC, { requestId: 'a', expiresInMs: 1_000 });
      const stale2 = await hold(userId, 2n * USDC, { requestId: 'b', expiresInMs: 1_000 });
      const fresh = await hold(userId, 3n * USDC, { requestId: 'c' });
      const done = await hold(userId, USDC, { requestId: 'd', expiresInMs: 1_000 });
      await capture(done.holdId, 500_000n, requestRecord('d'));

      const count = await expireHolds(new Date(now + 60_000));

      expect(count).toBe(2);
      expect((await Ledger.findById(stale.holdId).orFail()).status).toBe('expired');
      expect((await Ledger.findById(stale2.holdId).orFail()).status).toBe('expired');
      expect((await Ledger.findById(fresh.holdId).orFail()).status).toBe('open');
      expect(await balances(userId)).toEqual({ balance: 9_500_000n, held: 3n * USDC });
      expect(await Ledger.countDocuments({ type: 'release' })).toBe(2);
      expect(await expireHolds(new Date(now + 60_000))).toBe(0);
    });
  });

  describe('credit and adjust', () => {
    it('credits a deposit by signature and a settlement credit by id', async () => {
      const userId = await newUser();
      const settlementId = new Types.ObjectId();

      const a = await credit(userId, 4n * USDC, { txSignature: SIG });
      const b = await credit(userId, USDC, { settlementId });

      expect(a.entry.type).toBe('deposit');
      expect(a.entry.ref.txSignature).toBe(SIG);
      expect(a.balanceMicro).toBe(4n * USDC);
      expect(b.entry.type).toBe('adjust');
      expect(b.entry.ref.settlementId?.equals(settlementId)).toBe(true);
      expect(b.entry.balanceAfterMicroUsdc).toBe(5n * USDC);
      expect((await balances(userId)).balance).toBe(5n * USDC);
      await expect(credit(userId, 0n, { txSignature: SIG })).rejects.toThrow(RangeError);
    });

    it('adjusts the balance by a signed delta with a reason', async () => {
      const userId = await newUser(5n * USDC);
      const result = await adjust(userId, -2n * USDC, 'refund reversal');

      expect(result.balanceMicro).toBe(3n * USDC);
      expect(result.entry.type).toBe('adjust');
      expect(result.entry.reason).toBe('refund reversal');
      expect(result.entry.amountMicroUsdc).toBe(-2n * USDC);
    });

    it('rejects an unknown user with not_found', async () => {
      const err: unknown = await adjust(new Types.ObjectId(), 1n, 'x').catch((e: unknown) => e);
      expect(isAppError(err) && err.code).toBe('not_found');
    });
  });

  describe('recomputeBalance', () => {
    it('equals the stored balance after a mixed sequence', async () => {
      const userId = await newUser(10n * USDC);
      const other = await newUser(7n * USDC);

      const h1 = await hold(userId, 2n * USDC, { requestId: 'm1' });
      await capture(h1.holdId, 1_234_567n, requestRecord('m1'));
      const h2 = await hold(userId, USDC, { requestId: 'm2' });
      await release(h2.holdId);
      await hold(userId, USDC, { requestId: 'm3', expiresInMs: 1 });
      await expireHolds(new Date(Date.now() + 1_000));
      const h4 = await hold(userId, 3n * USDC, { requestId: 'm4' });
      await capture(h4.holdId, 2_000_001n, requestRecord('m4'));
      await capture(h4.holdId, 2_000_001n, requestRecord('m4'));
      await credit(userId, 3n * USDC, { txSignature: `${SIG}x` });
      await adjust(userId, -500_000n, 'manual');
      await hold(userId, USDC, { requestId: 'm5' });

      const stored = await balances(userId);
      expect(stored.balance).toBe(10n * USDC - 1_234_567n - 2_000_001n + 3n * USDC - 500_000n);
      expect(await recomputeBalance(userId)).toBe(stored.balance);
      expect(await recomputeBalance(other)).toBe(7n * USDC);
      expect(await recomputeBalance(new Types.ObjectId())).toBe(0n);
    });
  });
});
