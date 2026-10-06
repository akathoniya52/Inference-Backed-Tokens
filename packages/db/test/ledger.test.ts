import { HOLD_TTL_MS, isAppError } from '@ibt/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testDbUri } from './db-uri.js';

import {
  ALL_MODELS,
  DailySpend,
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
  findDueCaptures,
  hold,
  isHoldUnbilled,
  markCaptureDue,
  recomputeBalance,
  recomputeHeld,
  release,
  syncAllIndexes,
  withTransaction,
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

function utcYmd(date: Date): [number, number, number] {
  return [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
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

    it('concurrent holds with the same requestId: exactly one succeeds', async () => {
      const userId = await newUser(10n * USDC);

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => hold(userId, USDC, { requestId: 'same' })),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(isAppError(r.reason) && r.reason.code).toBe('invalid_request');
        }
      }
      expect(await balances(userId)).toEqual({ balance: 10n * USDC, held: USDC });
      expect(await Ledger.countDocuments({ type: 'hold' })).toBe(1);
    }, 60_000);

    it('a requestId stays claimed after its hold is captured', async () => {
      const userId = await newUser(10n * USDC);
      const h = await hold(userId, USDC, { requestId: 'once' });
      await capture(h.holdId, 1n, requestRecord('once'));

      const err: unknown = await hold(userId, USDC, { requestId: 'once' }).catch((e: unknown) => e);
      expect(isAppError(err) && err.code).toBe('invalid_request');
      expect(await balances(userId)).toEqual({ balance: 10n * USDC - 1n, held: 0n });
    });
  });

  describe('daily cap', () => {
    const day = new Date(Date.UTC(2026, 9, 5));

    function capOf(apiKeyId: Types.ObjectId, capMicro: bigint) {
      return { apiKeyId, day, capMicro };
    }

    async function reserved(apiKeyId: Types.ObjectId): Promise<bigint | undefined> {
      return (await DailySpend.findOne({ apiKeyId, day }).lean())?.reservedMicroUsdc;
    }

    it('concurrent holds never reserve past the cap', async () => {
      const userId = await newUser(100n * USDC);
      const apiKeyId = new Types.ObjectId();

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          hold(userId, USDC, { requestId: `cap${i}`, dailyCap: capOf(apiKeyId, 5n * USDC) }),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(isAppError(r.reason) && r.reason.code).toBe('daily_cap_exceeded');
        }
      }
      expect(await reserved(apiKeyId)).toBe(5n * USDC);
      expect((await balances(userId)).held).toBe(5n * USDC);
    }, 60_000);

    it('capture keeps the billed cost and release frees the whole estimate', async () => {
      const userId = await newUser(100n * USDC);
      const apiKeyId = new Types.ObjectId();
      const cap = capOf(apiKeyId, 3n * USDC);

      const a = await hold(userId, 2n * USDC, { requestId: 'd1', dailyCap: cap });
      await expect(hold(userId, 2n * USDC, { requestId: 'd2', dailyCap: cap })).rejects.toThrow();
      await capture(a.holdId, 500_000n, requestRecord('d1'));
      expect(await reserved(apiKeyId)).toBe(500_000n);

      const b = await hold(userId, 2n * USDC, { requestId: 'd3', dailyCap: cap });
      expect(await reserved(apiKeyId)).toBe(2_500_000n);
      await release(b.holdId);
      expect(await reserved(apiKeyId)).toBe(500_000n);

      const c = await hold(userId, USDC, { requestId: 'd4', dailyCap: cap, expiresInMs: 1 });
      await expireHolds(new Date(Date.now() + 1_000));
      expect((await Ledger.findById(c.holdId).orFail()).status).toBe('expired');
      expect(await reserved(apiKeyId)).toBe(500_000n);
    });

    it('seeds a new day from the spend already in requests', async () => {
      const userId = await newUser(100n * USDC);
      const apiKeyId = new Types.ObjectId();
      await Requests.create({
        ...requestRecord('seed'),
        userId,
        apiKeyId,
        costMicroUsdc: 2n * USDC,
        createdAt: new Date(day.getTime() + 60_000),
      });

      const err: unknown = await hold(userId, 2n * USDC, {
        requestId: 'seeded',
        dailyCap: capOf(apiKeyId, 3n * USDC),
      }).catch((e: unknown) => e);
      expect(isAppError(err) && err.code).toBe('daily_cap_exceeded');
      expect(await reserved(apiKeyId)).toBe(2n * USDC);
      expect(await Ledger.countDocuments({ type: 'hold' })).toBe(0);
    });

    it('counts a capture after midnight on the day its hold reserved, not twice (DB-05)', async () => {
      const userId = await newUser(100n * USDC);
      const apiKeyId = new Types.ObjectId();
      const today = new Date(Date.UTC(...utcYmd(new Date())));
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

      // Held on yesterday's row; the request row is written now, i.e. today.
      const late = await hold(userId, 2n * USDC, {
        requestId: 'late',
        dailyCap: { apiKeyId, day: yesterday, capMicro: 10n * USDC },
      });
      await capture(late.holdId, USDC, { ...requestRecord('late'), apiKeyId });
      const request = await Requests.findOne({ requestId: 'late' }).orFail();
      expect(request.dailyCapDay?.getTime()).toBe(yesterday.getTime());
      expect(
        (await DailySpend.findOne({ apiKeyId, day: yesterday }).orFail()).reservedMicroUsdc,
      ).toBe(USDC);

      // Today's row is seeded on its first hold: the late capture is not counted again,
      // while an uncapped request written today still is.
      await Requests.create({ ...requestRecord('uncapped'), userId, apiKeyId, costMicroUsdc: 3n });
      await hold(userId, USDC, {
        requestId: 'next',
        dailyCap: { apiKeyId, day: today, capMicro: 10n * USDC },
      });
      expect((await DailySpend.findOne({ apiKeyId, day: today }).orFail()).reservedMicroUsdc).toBe(
        USDC + 3n,
      );
    });
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

    it('refuses a cost above the hold and leaves the hold open (DB-01)', async () => {
      const userId = await newUser(5n * USDC);
      const apiKeyId = new Types.ObjectId();
      const day = new Date(Date.UTC(2026, 9, 5));
      const h = await hold(userId, 2n * USDC, {
        requestId: 'r1',
        dailyCap: { apiKeyId, day, capMicro: 10n * USDC },
      });

      const err: unknown = await capture(h.holdId, 2n * USDC + 1n, requestRecord('r1')).catch(
        (e: unknown) => e,
      );

      expect(isAppError(err) && err.code).toBe('internal');
      expect(isAppError(err) && err.toEnvelope().error.message).toBe('internal error');
      expect(await balances(userId)).toEqual({ balance: 5n * USDC, held: 2n * USDC });
      expect((await Ledger.findById(h.holdId).orFail()).status).toBe('open');
      expect(await Ledger.countDocuments({ type: 'capture' })).toBe(0);
      expect(await Requests.countDocuments({})).toBe(0);
      expect((await DailySpend.findOne({ apiKeyId, day }).orFail()).reservedMicroUsdc).toBe(
        2n * USDC,
      );

      await capture(h.holdId, 2n * USDC, requestRecord('r1'));
      expect(await balances(userId)).toEqual({ balance: 3n * USDC, held: 0n });
    });

    it('allows one capture row per hold (DB-04)', async () => {
      const userId = await newUser(5n * USDC);
      const h = await hold(userId, 2n * USDC, { requestId: 'r1' });
      const { entry } = await capture(h.holdId, USDC, requestRecord('r1'));

      await expect(
        Ledger.create({
          userId,
          type: 'capture',
          amountMicroUsdc: -USDC,
          ref: { requestId: 'r1', holdId: h.holdId },
        }),
      ).rejects.toThrow(/duplicate key/);
      const lookup = await Ledger.find({ type: 'capture', 'ref.holdId': h.holdId })
        .explain('queryPlanner')
        .then((plan) =>
          JSON.stringify(plan, (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        );
      expect(lookup).toContain('IXSCAN');
      expect(entry.ref.holdId?.equals(h.holdId)).toBe(true);
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

  describe('due captures (GW-12)', () => {
    it('a hold with a capture due is never released or expired, only captured once', async () => {
      const userId = await newUser(10n * USDC);
      const now = Date.now();
      const { holdId } = await hold(userId, 2n * USDC, { requestId: 'due', expiresInMs: 1_000 });
      const record = { ...requestRecord('due'), streamed: true };
      expect(await markCaptureDue(holdId, 3n * USDC, record)).toBe(false);
      expect(await markCaptureDue(holdId, USDC, record)).toBe(true);

      expect((await release(holdId)).released).toBe(false);
      expect(await expireHolds(new Date(now + 60_000))).toBe(0);
      expect(await isHoldUnbilled(holdId)).toBe(false);
      expect(await findDueCaptures(new Date(now))).toEqual([]);
      const [due, ...rest] = await findDueCaptures(new Date(now + 60_000));
      expect(rest).toEqual([]);
      expect(due).toEqual({ holdId, costMicro: USDC, request: record });
      if (!due) throw new Error('no due capture');

      await capture(due.holdId, due.costMicro, due.request);
      expect((await capture(due.holdId, due.costMicro, due.request)).alreadyCaptured).toBe(true);
      expect(await balances(userId)).toEqual({ balance: 9n * USDC, held: 0n });
      expect(await findDueCaptures(new Date(now + 60_000))).toEqual([]);
      // A closed hold takes no due capture.
      expect(await markCaptureDue(holdId, USDC, record)).toBe(false);
    });

    it('isHoldUnbilled is true only for released or expired holds', async () => {
      const userId = await newUser(10n * USDC);
      const released = await hold(userId, USDC, { requestId: 'u1' });
      await release(released.holdId);
      const captured = await hold(userId, USDC, { requestId: 'u2' });
      await capture(captured.holdId, 1n, requestRecord('u2'));
      const open = await hold(userId, USDC, { requestId: 'u3' });
      expect(await isHoldUnbilled(released.holdId)).toBe(true);
      expect(await isHoldUnbilled(captured.holdId)).toBe(false);
      expect(await isHoldUnbilled(open.holdId)).toBe(false);
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
      const debit: unknown = await adjust(new Types.ObjectId(), -1n, 'x').catch((e: unknown) => e);
      expect(isAppError(debit) && debit.code).toBe('not_found');
    });

    it('floors a negative delta at spendable funds unless allowNegative (DB-02)', async () => {
      const userId = await newUser(5n * USDC);
      await hold(userId, 2n * USDC, { requestId: 'h' });

      const err: unknown = await adjust(userId, -3n * USDC - 1n, 'clawback').catch(
        (e: unknown) => e,
      );
      expect(isAppError(err) && err.code).toBe('insufficient_credits');
      expect(isAppError(err) && err.details).toEqual({ shortfallUsdc: '0.000001' });
      expect(await balances(userId)).toEqual({ balance: 5n * USDC, held: 2n * USDC });
      expect(await Ledger.countDocuments({ type: 'adjust' })).toBe(0);

      expect((await adjust(userId, -3n * USDC, 'clawback')).balanceMicro).toBe(2n * USDC);
      const forced = await adjust(userId, -5n * USDC, 'chargeback', { allowNegative: true });
      expect(forced.balanceMicro).toBe(-3n * USDC);
      expect(await balances(userId)).toEqual({ balance: -3n * USDC, held: 2n * USDC });
    });

    it('concurrent debits never take spendable funds below zero', async () => {
      const userId = await newUser(5n * USDC);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => adjust(userId, -USDC, 'debit')),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      expect((await balances(userId)).balance).toBe(0n);
    }, 60_000);

    it('credits a deposit signature or a settlement at most once (DB-03)', async () => {
      const userId = await newUser();
      const settlementId = new Types.ObjectId();
      await credit(userId, USDC, { txSignature: SIG });
      await credit(userId, USDC, { settlementId });

      await expect(credit(userId, USDC, { txSignature: SIG })).rejects.toThrow(/duplicate key/);
      await expect(credit(userId, USDC, { settlementId })).rejects.toThrow(/duplicate key/);
      expect((await balances(userId)).balance).toBe(2n * USDC);
      expect(await recomputeBalance(userId)).toBe(2n * USDC);

      // Manual adjustments carry no settlement id and stay unconstrained.
      await adjust(userId, USDC, 'manual');
      await adjust(userId, USDC, 'manual');
      expect((await balances(userId)).balance).toBe(4n * USDC);
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

  describe('recomputeHeld (KPR-07)', () => {
    it('equals the stored held amount: open holds only', async () => {
      const userId = await newUser(10n * USDC);
      await hold(userId, 2n * USDC, { requestId: 'o1' });
      await hold(userId, 3n * USDC, { requestId: 'o2' });
      const captured = await hold(userId, USDC, { requestId: 'c' });
      await capture(captured.holdId, 1n, requestRecord('c'));
      const released = await hold(userId, USDC, { requestId: 'r' });
      await release(released.holdId);

      expect(await recomputeHeld(userId)).toBe(5n * USDC);
      expect((await balances(userId)).held).toBe(5n * USDC);
      expect(await recomputeHeld(new Types.ObjectId())).toBe(0n);
    });

    it('reads cached and ledger values in one transaction snapshot', async () => {
      const userId = await newUser(10n * USDC);
      await hold(userId, 2n * USDC, { requestId: 's1' });

      const seen = await withTransaction(async (session) => {
        const user = await Users.findById(userId, null, { session }).orFail();
        // A credit committed after the snapshot opened stays invisible to it.
        await credit(userId, USDC, { txSignature: `${SIG}late` });
        return {
          balance: user.balanceMicroUsdc,
          held: user.heldMicroUsdc,
          ledgerBalance: await recomputeBalance(userId, { session }),
          ledgerHeld: await recomputeHeld(userId, { session }),
        };
      });

      expect(seen).toEqual({
        balance: 10n * USDC,
        held: 2n * USDC,
        ledgerBalance: 10n * USDC,
        ledgerHeld: 2n * USDC,
      });
      expect(await recomputeBalance(userId)).toBe(11n * USDC);
    });
  });
});
