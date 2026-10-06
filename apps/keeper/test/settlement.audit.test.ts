import { AppError } from '@ibt/shared';
import {
  Leases,
  Models,
  Settlements,
  Users,
  mongoose,
  withTransaction,
  type ClientSession,
  type SettlementDoc,
  type Types,
} from '@ibt/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectedPayoutMicro } from '../src/jobs/floatMonitor.js';
import { createPoolPoller } from '../src/jobs/poolPoller.js';
import { createReconcileJob } from '../src/jobs/reconcile.js';
import { createStatsJob } from '../src/jobs/stats.js';
import { createLease } from '../src/lease.js';
import { createScheduler } from '../src/scheduler.js';
import { isRetryable } from '../src/settlement/engine.js';
import {
  SettlementConflictError,
  claimSettlement,
  fence,
  saveIf,
} from '../src/settlement/fence.js';
import { MAX_PERIODS_PER_RUN, periodsToOpen } from '../src/settlement/orchestrator.js';
import { parsePeriodStart, periodFromStart } from '../src/settlement/period.js';
import {
  PendingTxUnresolvedError,
  resolvePendingTx,
  sendWithPendingTx,
} from '../src/settlement/pendingTx.js';
import {
  SettlementDeferredError,
  allowedSolPriceDeviationPct,
  buyAndLock,
  convert,
  lease,
  payProvider,
  split,
  tagAndSum,
} from '../src/settlement/steps.js';
import {
  addRequest,
  createTestModel,
  makeKeeperCtx,
  micro,
  type TestKeeperCtx,
} from './helpers.js';

const HOUR = 3_600_000;
const BASE = new Date('2026-09-01T00:00:00Z');
let hourSeq = 0;
const nextHour = () => new Date(BASE.getTime() + (hourSeq += 1) * HOUR);

describe('keeper audit fixes', () => {
  let ctx: TestKeeperCtx;

  beforeAll(async () => {
    ctx = await makeKeeperCtx();
    ctx.chain.setUsdc(ctx.treasury.publicKey, micro(1_000_000));
    ctx.chain.setSol(ctx.keeper.publicKey, 1_000_000_000_000n);
  });

  beforeEach(() => {
    ctx.alerter.alerts.length = 0;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function open(modelId: Types.ObjectId, revenue = micro(10)): Promise<SettlementDoc> {
    const start = nextHour();
    await addRequest(modelId, revenue, start);
    const doc = await lease(ctx, { modelId, ...periodFromStart(start) });
    if (!doc) throw new Error('lease expected');
    return fence(doc);
  }

  const reload = async (doc: SettlementDoc) => fence(await Settlements.findById(doc._id).orFail());

  describe('KPR-01 saveIf', () => {
    it('an empty delta under a stale fence throws SettlementConflictError', async () => {
      const { model } = await createTestModel(ctx);
      const doc = await claimSettlement(
        { ...ctx, lease: { isHeld: () => true, epoch: () => 5 } },
        await open(model._id),
      );
      await Settlements.updateOne({ _id: doc._id }, { $set: { leaseEpoch: 6 } });
      expect(doc.isModified()).toBe(false);
      await expect(saveIf(doc, {})).rejects.toBeInstanceOf(SettlementConflictError);
      await expect(
        withTransaction((session) => saveIf(doc, { lastCompletedState: 'computing' }, session)),
      ).rejects.toBeInstanceOf(SettlementConflictError);
    });

    it('a transaction retried after a transient commit error still writes the settlement with the model', async () => {
      const { model } = await createTestModel(ctx);
      const doc = await open(model._id);
      let attempts = 0;
      await withTransaction(async (session: ClientSession) => {
        attempts += 1;
        await Models.updateOne(
          { _id: model._id },
          { $inc: { 'token.pendingCompoundLamports': 7n } },
          { session },
        );
        doc.revenueMicroUsdc = 4242n;
        await saveIf(doc, { lastCompletedState: 'computing' }, session);
        if (attempts === 1) {
          const commit = session.commitTransaction.bind(session);
          session.commitTransaction = async () => {
            session.commitTransaction = commit;
            await session.abortTransaction();
            throw new mongoose.mongo.MongoServerError({
              message: 'simulated WriteConflict at commit',
              code: 112,
              errorLabels: ['TransientTransactionError'],
            });
          };
        }
      });
      expect(attempts).toBe(2);
      expect((await Settlements.findById(doc._id).lean())?.revenueMicroUsdc).toBe(4242n);
      expect((await Models.findById(model._id).lean())?.token.pendingCompoundLamports).toBe(7n);
    });
  });

  describe('KPR-05 / CHN-01 pendingTx', () => {
    async function signedDoc() {
      const { model } = await createTestModel(ctx);
      const doc = await open(model._id);
      await tagAndSum(ctx, doc);
      await split(ctx, doc);
      return doc;
    }

    it('a processed-only (pending) signature is never treated as landed nor re-sent', async () => {
      const doc = await signedDoc();
      doc.pendingTx = {
        step: 'payProvider:payout',
        signature: 'sigPending',
        lastValidBlockHeight: 100,
      };
      await saveIf(doc, {});
      ctx.setBlockHeight(50);
      vi.spyOn(ctx.chain, 'signatureStatus').mockResolvedValue('pending');
      const send = vi.fn();
      try {
        await expect(sendWithPendingTx(ctx, doc, 'payProvider', send)).rejects.toBeInstanceOf(
          PendingTxUnresolvedError,
        );
      } finally {
        ctx.setBlockHeight(Number.MAX_SAFE_INTEGER);
      }
      expect(send).not.toHaveBeenCalled();
      expect((await reload(doc)).pendingTx?.signature).toBe('sigPending');
    });

    it('keeps a replaced signature and resolves it before any resend', async () => {
      const doc = await signedDoc();
      const landed = await ctx.chain.transferUsdc(ctx.treasury, ctx.keeper.publicKey, 1n);
      await expect(
        sendWithPendingTx(ctx, doc, 'payProvider', async (opts) => {
          await opts.onSigned?.(landed.signature, 10, 'payout');
          await opts.onSigned?.('sigNeverSent', 20, 'payout');
          throw new AppError('chain_send_failed', {
            details: { signature: 'sigNeverSent', lastValidBlockHeight: 20 },
          });
        }),
      ).rejects.toBeInstanceOf(AppError);
      const stored = await reload(doc);
      expect(stored.pendingTx?.signature).toBe('sigNeverSent');
      const raw = await Settlements.collection.findOne({ _id: doc._id });
      expect(raw?.pendingTxHistory).toEqual([
        { step: 'payProvider:payout', signature: landed.signature, lastValidBlockHeight: 10 },
      ]);

      const send = vi.fn();
      const resumed = await sendWithPendingTx(ctx, stored, 'payProvider', send);
      expect(resumed).toEqual({ signature: landed.signature, result: null });
      expect(send).not.toHaveBeenCalled();
    });

    it('a chain_send_failed after signing leaves the signature to resolve, never re-sent blindly', async () => {
      const doc = await signedDoc();
      ctx.chain.crashAfter('transferUsdc');
      await expect(payProvider(ctx, doc)).rejects.toThrow(/fake crash/);
      const stored = await reload(doc);
      const signature = stored.pendingTx?.signature;
      expect(signature).toBeTruthy();
      expect(await resolvePendingTx(ctx, stored, 'payProvider')).toBeNull();
      expect((await Settlements.collection.findOne({ _id: doc._id }))?.pendingTx).toBeNull();
    });
  });

  describe('KPR-06 payout budget at send time', () => {
    async function reservedDoc(amount: bigint) {
      const { model } = await createTestModel(ctx);
      const doc = await open(model._id);
      await tagAndSum(ctx, doc);
      await split(ctx, doc);
      await Settlements.updateOne(
        { _id: doc._id },
        { $set: { 'provider.reserved': true, 'provider.amountMicroUsdc': amount } },
      );
      return reload(doc);
    }

    it('defers a resumed payout that does not fit the run budget, without sending', async () => {
      const doc = await reservedDoc(micro(9));
      const transfer = vi.spyOn(ctx.chain, 'transferUsdc');
      const run = {
        ...ctx,
        payoutBudget: { remainingMicroUsdc: micro(5), charged: new Set<string>() },
      };
      await expect(payProvider(run, doc)).rejects.toBeInstanceOf(SettlementDeferredError);
      expect(transfer).not.toHaveBeenCalled();
      expect(run.payoutBudget.remainingMicroUsdc).toBe(micro(5));
      expect((await reload(doc)).pendingTx).toBeNull();
    });

    it('charges a resumed payout against the run budget when it is sent', async () => {
      const doc = await reservedDoc(micro(9));
      const run = {
        ...ctx,
        payoutBudget: { remainingMicroUsdc: micro(20), charged: new Set<string>() },
      };
      await payProvider(run, doc);
      expect(run.payoutBudget.remainingMicroUsdc).toBe(micro(11));
      expect((await reload(doc)).lastCompletedState).toBe('paid_provider');
    });
  });

  describe('KPR-02 migration', () => {
    it('re-reads the pool after a dropped migrate and never resends to a migrated pool', async () => {
      const { model, pool } = await createTestModel(ctx, 'curve');
      if (!pool) throw new Error('pool expected');
      const doc = await open(model._id);
      ctx.chain.migrateWhen(1n);
      try {
        await tagAndSum(ctx, doc);
        await split(ctx, doc);
        await payProvider(ctx, doc);
        await convert(ctx, doc);
        ctx.chain.crashAfter('migrate');
        await expect(buyAndLock(ctx, doc)).rejects.toThrow(/fake crash/);
        const stored = await reload(doc);
        const dropped = stored.pendingTx?.signature;
        expect(stored.pendingTx?.step).toBe('buyAndLock:migrate');
        expect((await Models.findById(model._id).lean())?.token.migrationSignature).toBe(dropped);

        // The pool poller migrates the pool meanwhile.
        const poller = await ctx.chain.migrate(ctx.keeper, pool);
        const migrate = vi.spyOn(ctx.chain, 'migrate');
        await buyAndLock(ctx, stored);
        expect(migrate).not.toHaveBeenCalled();
        const after = await reload(doc);
        expect(after.lastCompletedState).toBe('locked');
        expect(after.liquidity.migrationSignature).toBeNull();
        // The dropped signature was released.
        expect((await Models.findById(model._id).lean())?.token.migrationSignature).toBeNull();
        expect(poller.signature).toBeTruthy();
      } finally {
        ctx.chain.migrateWhen(10_000_000_000n);
      }
    });

    /** Before the latest signature leaves, the send signs `dead` first (CHN-01 re-sign). */
    function resignNextMigrate(dead: string, beforeLanding?: () => Promise<void>) {
      const migrate = ctx.chain.migrate.bind(ctx.chain);
      return vi.spyOn(ctx.chain, 'migrate').mockImplementationOnce(async (keeper, pool, opts) => {
        await opts?.onSigned?.(dead, 0, 'migrate');
        return migrate(keeper, pool, {
          ...opts,
          onSigned: async (sig, lastValidBlockHeight, chainStep) => {
            await opts?.onSigned?.(sig, lastValidBlockHeight, chainStep);
            await beforeLanding?.();
          },
        });
      });
    }

    async function convertedOnCompleteCurve() {
      const { model, pool } = await createTestModel(ctx, 'curve');
      if (!pool) throw new Error('pool expected');
      const doc = await open(model._id);
      await tagAndSum(ctx, doc);
      await split(ctx, doc);
      await payProvider(ctx, doc);
      await convert(ctx, doc);
      return { model, pool, doc };
    }

    const migrationSignatureOf = async (modelId: Types.ObjectId) =>
      (await Models.findById(modelId).lean())?.token.migrationSignature;

    it('a re-signed migrate stores its latest signature, which the pool poller waits on', async () => {
      ctx.chain.migrateWhen(1n);
      try {
        const { model, pool, doc } = await convertedOnCompleteCurve();
        const poller = createPoolPoller(ctx);
        let inFlight: string | null | undefined;
        const migrate = resignNextMigrate('sigDeadMigrateA', async () => {
          inFlight = await migrationSignatureOf(model._id);
          ctx.setBlockHeight(0);
          try {
            await poller.tick();
          } finally {
            ctx.setBlockHeight(Number.MAX_SAFE_INTEGER);
          }
        });
        await buyAndLock(ctx, doc);
        const latest = (await reload(doc)).liquidity.migrationSignature;
        expect(latest).toEqual(expect.any(String));
        expect(latest).not.toBe('sigDeadMigrateA');
        expect(inFlight).toBe(latest);
        expect(await migrationSignatureOf(model._id)).toBe(latest);
        // The poller found the settlement's in-flight migrate and sent nothing.
        expect(migrate.mock.calls.filter(([, p]) => p.equals(pool))).toHaveLength(1);
      } finally {
        ctx.chain.migrateWhen(10_000_000_000n);
      }
    });

    it('a re-signed migrate that did not land is released on resume', async () => {
      ctx.chain.migrateWhen(1n);
      try {
        const { model, pool, doc } = await convertedOnCompleteCurve();
        resignNextMigrate('sigDeadMigrateB');
        ctx.chain.crashAfter('migrate');
        await expect(buyAndLock(ctx, doc)).rejects.toThrow(/fake crash/);
        const stored = await reload(doc);
        const latest = stored.pendingTx?.signature;
        expect(latest).not.toBe('sigDeadMigrateB');
        expect(await migrationSignatureOf(model._id)).toBe(latest);

        await ctx.chain.migrate(ctx.keeper, pool);
        await buyAndLock(ctx, stored);
        expect((await reload(doc)).lastCompletedState).toBe('locked');
        expect(await migrationSignatureOf(model._id)).toBeNull();
      } finally {
        ctx.chain.migrateWhen(10_000_000_000n);
      }
    });
  });

  describe('CHN-03 curve buy amounts', () => {
    it('a resumed curve buy records the actual fill and compounds the unspent lamports', async () => {
      const { model } = await createTestModel(ctx, 'curve');
      const doc = await open(model._id);
      await tagAndSum(ctx, doc);
      await split(ctx, doc);
      await payProvider(ctx, doc);
      await convert(ctx, doc);
      const lamports = (await reload(doc)).liquidity.solLamports ?? 0n;
      ctx.chain.crashAfterLand('curveBuy');
      await expect(buyAndLock(ctx, doc)).rejects.toThrow(/fake crash/);
      const fill = vi
        .spyOn(ctx.chain, 'swapFill')
        .mockResolvedValue({ amountIn: lamports - 100n, amountOut: 777n });
      const before = await Models.findById(model._id).lean();
      await buyAndLock(ctx, await reload(doc));
      expect(fill).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ venue: 'curve' }),
      );
      const after = await reload(doc);
      expect(after.liquidity.solAddedLamports).toBe(lamports - 100n);
      expect(after.liquidity.tokensBaseUnits).toBe(777n);
      const model2 = await Models.findById(model._id).lean();
      expect(model2?.token.escrowBaseUnits).toBe((before?.token.escrowBaseUnits ?? 0n) + 777n);
      expect(model2?.token.pendingCompoundLamports).toBe(
        (before?.token.pendingCompoundLamports ?? 0n) + 100n,
      );
    });
  });

  describe('small fixes', () => {
    it('KPR-11: status codes only match as whole words', () => {
      expect(isRetryable(new Error('model 6650a502c0ffee5029a4b111 not found'))).toBe(false);
      expect(isRetryable(new Error('HTTP 503 Service Unavailable'))).toBe(true);
      expect(isRetryable(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(true);
    });

    it('KPR-10: --period-start needs an offset and an ended period unless forced', () => {
      const now = new Date('2026-10-06T12:30:00Z');
      expect(() => parsePeriodStart('2026-10-06T10:00:00', now)).toThrow(/offset/);
      expect(parsePeriodStart('2026-10-06T10:00:00Z', now).periodEnd.toISOString()).toBe(
        '2026-10-06T11:00:00.000Z',
      );
      expect(parsePeriodStart('2026-10-06T15:30:00+05:30', now).periodStart.toISOString()).toBe(
        '2026-10-06T10:00:00.000Z',
      );
      expect(() => parsePeriodStart('2026-10-06T12:00:00Z', now)).toThrow(/--force/);
      expect(parsePeriodStart('2026-10-06T12:00:00Z', now, { force: true })).toBeDefined();
    });

    it('KPR-08: missed periods are opened oldest first, bounded per run', () => {
      const target = periodFromStart(new Date('2026-10-06T10:00:00Z'));
      expect(periodsToOpen(null, target)).toEqual([target]);
      const three = periodsToOpen(new Date('2026-10-06T07:00:00Z'), target);
      expect(three.map((p) => p.periodStart.toISOString())).toEqual([
        '2026-10-06T08:00:00.000Z',
        '2026-10-06T09:00:00.000Z',
        '2026-10-06T10:00:00.000Z',
      ]);
      const many = periodsToOpen(new Date('2026-09-01T00:00:00Z'), target);
      expect(many).toHaveLength(MAX_PERIODS_PER_RUN);
      expect(many[0]?.periodStart.toISOString()).toBe('2026-09-01T01:00:00.000Z');
    });

    it('KPR-04: the allowed SOL move widens with reference age; old references stop binding', () => {
      expect(allowedSolPriceDeviationPct(10 * 60_000)).toBe(30n);
      expect(allowedSolPriceDeviationPct(2.5 * HOUR)).toBe(50n);
      expect(allowedSolPriceDeviationPct(7 * HOUR)).toBeNull();
    });

    it('KPR-04: convert orders the reference by pricedAt and a stale one does not lock the guard', async () => {
      const { model } = await createTestModel(ctx);
      await Models.updateOne({ _id: model._id }, { $set: { 'token.status': 'graduated' } });
      const old = await open(model._id);
      await Settlements.updateOne(
        { _id: old._id },
        {
          $set: {
            state: 'done',
            'liquidity.solPriceUsdc': '10.000000',
            'liquidity.pricedAt': new Date(ctx.clock.now().getTime() - 8 * HOUR),
          },
        },
      );
      const doc = await open(model._id);
      await tagAndSum(ctx, doc);
      await split(ctx, doc);
      await payProvider(ctx, doc);
      await convert(ctx, doc);
      const converted = await reload(doc);
      expect(converted.lastCompletedState).toBe('converted');
      expect(converted.liquidity.pricedAt?.getTime()).toBe(ctx.clock.now().getTime());
    });

    it('KPR-07: held drift is detected and fixed from the ledger', async () => {
      const user = await Users.create({
        wallet: `held-${Date.now()}`,
        depositRef: `HELD${String(Date.now()).slice(-4)}`,
        heldMicroUsdc: micro(2),
      });
      const report = await createReconcileJob(ctx).tick();
      const mine = report.drift.filter((d) => d.userId === user._id.toHexString());
      expect(mine).toEqual([
        expect.objectContaining({ field: 'held', cachedMicroUsdc: micro(2), ledgerMicroUsdc: 0n }),
      ]);
      expect((await Users.findById(user._id).lean())?.heldMicroUsdc).toBe(0n);
      expect(ctx.alerter.alerts.some((a) => a.title === 'held drift')).toBe(true);
    });

    it('KPR-12: curve settlements are not counted as locked liquidity', async () => {
      const { model } = await createTestModel(ctx);
      const curve = await open(model._id);
      const graduated = await open(model._id);
      await Settlements.updateOne(
        { _id: curve._id },
        { $set: { state: 'done', 'liquidity.phase': 'curve', 'liquidity.solAddedLamports': 5n } },
      );
      await Settlements.updateOne(
        { _id: graduated._id },
        {
          $set: { state: 'done', 'liquidity.phase': 'graduated', 'liquidity.solAddedLamports': 3n },
        },
      );
      await createStatsJob(ctx).tick();
      expect((await Models.findById(model._id).lean())?.stats.lockedLiquidityLamports).toBe(3n);
    });

    it('KPR-13: expected payouts are capped at MAX_PAYOUT_USDC_PER_RUN in total', async () => {
      for (let i = 0; i < 3; i += 1) {
        const { model } = await createTestModel(ctx);
        await addRequest(model._id, micro(1_000), nextHour());
      }
      expect(await expectedPayoutMicro(ctx)).toBe(ctx.config.maxPayoutMicroUsdc);
    });

    it('KPR-16: a failed renewal is retried while the lease is still valid', async () => {
      const onLost = vi.fn();
      const held = createLease({
        name: `retry-${Date.now()}`,
        holder: 'holder-a',
        logger: ctx.logger,
        retryMs: 1,
        onLost,
      });
      expect(await held.tick()).toBe(true);
      const claim = vi.spyOn(Leases, 'findOneAndUpdate').mockImplementationOnce(() => {
        throw new Error('db blip');
      });
      expect(await held.tick()).toBe(true);
      expect(claim).toHaveBeenCalledTimes(2);
      expect(onLost).not.toHaveBeenCalled();
      await held.stop();
      expect(onLost).toHaveBeenCalledTimes(1);
    });

    it('KPR-14: drain waits for running jobs, bounded by its timeout', async () => {
      const scheduler = createScheduler({ logger: ctx.logger });
      let finish = () => {};
      scheduler.add('slow', '0 0 1 1 *', () => new Promise<void>((resolve) => (finish = resolve)));
      scheduler.start();
      const run = scheduler.runNow('slow');
      scheduler.stop();
      expect(await scheduler.drain(5)).toBe(false);
      finish();
      expect(await scheduler.drain(1_000)).toBe(true);
      expect(await run).toBe(true);
      expect(await scheduler.drain(1)).toBe(true);
    });
  });
});
