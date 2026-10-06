import { FakePriceSource } from '@ibt/chain';
import type { FakeChainMethod } from '@ibt/chain/testing';
import { Leases, Models, Requests, Settlements, Types, type SettlementDoc } from '@ibt/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KeeperCtx, LeaseGuard } from '../src/ctx.js';
import { createLease } from '../src/lease.js';
import { isRetryable, runSettlement } from '../src/settlement/engine.js';
import {
  LeaseLostError,
  SettlementConflictError,
  claimSettlement,
} from '../src/settlement/fence.js';
import { createOrchestrator } from '../src/settlement/orchestrator.js';
import { PendingTxUnknownError } from '../src/settlement/pendingTx.js';
import { periodFromStart } from '../src/settlement/period.js';
import {
  SETTLEMENT_STEPS,
  SolPriceRejectedError,
  compound,
  lease,
  payProvider,
  runSteps,
  split,
  tagAndSum,
  type NamedStep,
} from '../src/settlement/steps.js';
import {
  addRequest,
  createTestModel,
  graduate,
  makeKeeperCtx,
  micro,
  type TestKeeperCtx,
  type TestModel,
} from './helpers.js';

const HOUR = 3_600_000;
const BASE = new Date('2026-06-01T00:00:00Z');
let hourSeq = 0;
const nextHour = () => new Date(BASE.getTime() + (hourSeq += 1) * HOUR);

const stepsThrough = (name: string): NamedStep[] =>
  SETTLEMENT_STEPS.slice(0, SETTLEMENT_STEPS.findIndex((s) => s.name === name) + 1);

const asc = (x: bigint, y: bigint) => (x < y ? -1 : x > y ? 1 : 0);

const guard = (epoch: number, held = true): LeaseGuard => ({
  isHeld: () => held,
  epoch: () => (held ? epoch : null),
});

describe('settlement money safety (E1–E7)', () => {
  let ctx: TestKeeperCtx;

  beforeAll(async () => {
    ctx = await makeKeeperCtx();
    ctx.chain.setUsdc(ctx.treasury.publicKey, micro(1_000_000));
    ctx.chain.setSol(ctx.keeper.publicKey, 1_000_000_000_000n);
  });

  beforeEach(() => {
    ctx.alerter.alerts.length = 0;
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function open(modelId: Types.ObjectId, start = nextHour(), revenue = micro(10)) {
    await addRequest(modelId, revenue, start);
    const doc = await lease(ctx, { modelId, ...periodFromStart(start) });
    if (!doc) throw new Error('lease expected');
    return doc;
  }

  const reload = async (doc: SettlementDoc) => {
    const fresh = await Settlements.findById(doc._id);
    if (!fresh) throw new Error('settlement vanished');
    return fresh;
  };

  const sendsOf = (doc: SettlementDoc, method: FakeChainMethod) =>
    ctx.chain.calls.filter(
      (c) =>
        c.method === method &&
        (c.args.at(-1) as { settlementRef?: string } | undefined)?.settlementRef ===
          doc._id.toHexString(),
    ).length;

  const landed = async (doc: SettlementDoc, method: string) =>
    (await ctx.chain.landedTxs({ settlementRef: doc._id.toHexString(), method })).length;

  /** Delists every other model so a run settles only `models` (earlier tests leave requests). */
  /**
   * Delists every other model and tags their billed requests, since a delisted model with
   * unsettled billed requests is still settled (KPR-09).
   */
  const onlyRun = async (models: TestModel[]) => {
    const others = { $nin: models.map((m) => m.model._id) };
    await Models.updateMany({ _id: others }, { $set: { status: 'delisted' } });
    await Requests.updateMany(
      { modelId: others, settlementId: null },
      { $set: { settlementId: new Types.ObjectId() } },
    );
  };

  const carryOf = async (modelId: Types.ObjectId) =>
    (await Models.findById(modelId).lean())?.token.carryOverMicroUsdc;

  it('lease lost mid-run: no further sends, and the run stops with LeaseLostError', async () => {
    const first = await createTestModel(ctx, 'curve');
    const second = await createTestModel(ctx, 'curve');
    const start = nextHour();
    await addRequest(first.model._id, micro(10), start);
    await addRequest(second.model._id, micro(10), start);
    let held = true;
    const runCtx: KeeperCtx = {
      ...ctx,
      lease: { isHeld: () => held, epoch: () => (held ? 7 : null) },
    };
    const original = ctx.chain.transferUsdc.bind(ctx.chain);
    const transfer = vi.spyOn(ctx.chain, 'transferUsdc').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      held = false;
      return result;
    });
    try {
      await expect(
        createOrchestrator(runCtx, { concurrency: 1 }).run(periodFromStart(start)),
      ).rejects.toBeInstanceOf(LeaseLostError);
    } finally {
      transfer.mockRestore();
    }

    const docs = await Settlements.find({ periodStart: start });
    expect(docs).toHaveLength(1);
    const [doc] = docs;
    if (!doc) throw new Error('settlement expected');
    expect(await landed(doc, 'transferUsdc')).toBe(1);
    expect(sendsOf(doc, 'curveBuy')).toBe(0);
    expect(doc.state).not.toBe('failed');
    expect(doc.leaseEpoch).toBe(7);
    expect(await Settlements.countDocuments({ modelId: second.model._id })).toBe(0);
  });

  it('two runners on the same settlement → exactly one transfer', async () => {
    const { model, providerWallet } = await createTestModel(ctx, 'curve');
    const doc = await open(model._id);
    const [a, b] = await Promise.all([
      runSettlement(ctx, await reload(doc)),
      runSettlement(ctx, await reload(doc)),
    ]);
    const final = await reload(doc);
    expect(final.state).toBe('done');
    expect([a.state, b.state]).toContain('done');
    expect(await landed(doc, 'transferUsdc')).toBe(1);
    expect(await landed(doc, 'curveBuy')).toBe(1);
    expect(await ctx.chain.usdcBalance(providerWallet)).toBe(micro(7));
  });

  it('a stale runner cannot reserve or send a payout another runner already made', async () => {
    const { model } = await createTestModel(ctx);
    const doc = await open(model._id);
    await tagAndSum(ctx, doc);
    await split(ctx, doc);
    const stale = await reload(doc);
    await payProvider(ctx, doc);
    expect(sendsOf(doc, 'transferUsdc')).toBe(1);

    await expect(payProvider(ctx, stale)).rejects.toBeInstanceOf(SettlementConflictError);
    expect(sendsOf(doc, 'transferUsdc')).toBe(1);
    expect(await carryOf(model._id)).toBe(0n);
  });

  it('two runners past the reservation: the pendingTx compare-and-set lets only one send', async () => {
    const { model, providerWallet } = await createTestModel(ctx);
    const doc = await open(model._id);
    await tagAndSum(ctx, doc);
    await split(ctx, doc);
    ctx.chain.failNext('transferUsdc');
    await expect(payProvider(ctx, doc)).rejects.toThrow();
    const [a, b] = [await reload(doc), await reload(doc)];
    expect(a.provider.reserved).toBe(true);
    expect(a.pendingTx).toBeNull();

    await payProvider(ctx, a);
    await expect(payProvider(ctx, b)).rejects.toBeInstanceOf(SettlementConflictError);
    expect(await landed(doc, 'transferUsdc')).toBe(1);
    expect(await ctx.chain.usdcBalance(providerWallet)).toBe(micro(9));
  });

  it('epoch fencing: an older holder is refused once a newer one claimed the settlement', async () => {
    const { model, providerWallet } = await createTestModel(ctx, 'curve');
    const doc = await open(model._id);
    const old: KeeperCtx = { ...ctx, lease: guard(10) };
    const stale = await claimSettlement(old, doc);
    expect(stale.leaseEpoch).toBe(10);

    const done = await runSettlement({ ...ctx, lease: guard(11) }, await reload(doc));
    expect(done.state).toBe('done');
    expect(done.leaseEpoch).toBe(11);
    const transfers = sendsOf(doc, 'transferUsdc');

    await expect(runSteps(old, stale, SETTLEMENT_STEPS)).rejects.toBeInstanceOf(
      SettlementConflictError,
    );
    await expect(runSettlement(old, await reload(doc))).rejects.toBeInstanceOf(LeaseLostError);
    expect(sendsOf(doc, 'transferUsdc')).toBe(transfers);
    expect(await ctx.chain.usdcBalance(providerWallet)).toBe(micro(7));
    expect((await reload(doc)).state).toBe('done');
  });

  it('lease epochs grow on every new holder, survive release, and stay put on renewal', async () => {
    const name = `epoch-${Date.now()}`;
    const opts = { name, ttlMs: 60_000, logger: ctx.logger };
    const a = createLease({ ...opts, holder: 'a' });
    const b = createLease({ ...opts, holder: 'b' });
    expect(await a.tick()).toBe(true);
    const first = a.epoch();
    expect(await a.tick()).toBe(true);
    expect(a.epoch()).toBe(first);
    expect(await b.tick()).toBe(false);
    expect(b.epoch()).toBeNull();

    await a.stop();
    expect(a.epoch()).toBeNull();
    expect(await b.tick()).toBe(true);
    const second = b.epoch();
    expect(second).toBeGreaterThan(first ?? Number.MAX_SAFE_INTEGER);
    await b.stop();
    expect(Number((await Leases.findOne({ name }).lean())?.epoch)).toBe(second);
    expect(await a.tick()).toBe(true);
    expect(a.epoch()).toBeGreaterThan(second ?? Number.MAX_SAFE_INTEGER);
    await a.stop();
  });

  it('an unrenewed lease stops counting as held once its TTL has passed locally', async () => {
    const held = createLease({
      name: `ttl-${Date.now()}`,
      holder: 'slow',
      ttlMs: 50,
      renewMs: 10_000,
      logger: ctx.logger,
    });
    expect(await held.tick()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(held.isHeld()).toBe(false);
    expect(held.epoch()).toBeNull();
    await held.stop();
  });

  it.each(['crashAfterLand', 'crashAfter'] as const)(
    'expired pendingTx with unknown status (%s) → no resend, pendingTx kept, alert',
    async (crash) => {
      const { model, providerWallet } = await createTestModel(ctx, 'curve');
      const doc = await open(model._id);
      ctx.chain[crash]('transferUsdc');
      await expect(runSteps(ctx, doc, stepsThrough('payProvider'))).rejects.toThrow(/crash/);
      const stored = (await reload(doc)).pendingTx?.signature;
      const transfers = sendsOf(doc, 'transferUsdc');

      ctx.chain.setHistoryAvailable(false);
      try {
        const failed = await runSettlement(ctx, await reload(doc), { attempts: 1 });
        expect(failed.state).toBe('failed');
        expect(failed.error).toMatch(/status is unknown; not resending/);
        expect(failed.pendingTx?.signature).toBe(stored);
      } finally {
        ctx.chain.setHistoryAvailable(true);
      }
      expect(sendsOf(doc, 'transferUsdc')).toBe(transfers);
      expect(ctx.alerter.alerts.map((a) => a.title)).toContain(
        'pendingTx expired with unknown status; not resending',
      );

      await Settlements.updateOne({ _id: doc._id }, { $set: { state: 'computing', error: null } });
      const done = await runSettlement(ctx, await reload(doc));
      expect(done.state).toBe('done');
      expect(await landed(doc, 'transferUsdc')).toBe(1);
      expect(await ctx.chain.usdcBalance(providerWallet)).toBe(micro(7));
    },
  );

  it.each([
    ['above the upper bound', 1_000_000],
    ['below the lower bound', 0.5],
    ['not a number', Number.NaN],
    ['33% below the last stored price', 100],
  ])('SOL price %s → retryable rejection, alert, nothing spent', async (_case, usd) => {
    const { model } = await createTestModel(ctx, 'curve');
    const doc = await open(model._id);
    const price = ctx.price;
    ctx.price = new FakePriceSource(usd);
    try {
      const failed = await runSettlement(ctx, doc, { attempts: 1 });
      expect(failed.state).toBe('failed');
      expect(failed.lastCompletedState).toBe('paid_provider');
      expect(failed.error).toMatch(/SOL price rejected/);
      expect(failed.liquidity.solPriceUsdc).toBeNull();
    } finally {
      ctx.price = price;
    }
    expect(sendsOf(doc, 'curveBuy')).toBe(0);
    expect((await Models.findById(model._id).lean())?.token.sliceCarryOverMicroUsdc).toBe(0n);
    expect(ctx.alerter.alerts.map((a) => a.title)).toContain('SOL price rejected');
    expect(isRetryable(new SolPriceRejectedError('x'))).toBe(true);
    expect(isRetryable(new PendingTxUnknownError('payProvider:payout', 'sig'))).toBe(true);
  });

  it('a SOL price within 30% of the last stored one is spent at', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    const price = ctx.price;
    ctx.price = new FakePriceSource(120);
    try {
      const done = await runSettlement(ctx, await open(model._id));
      expect(done.state).toBe('done');
      expect(done.liquidity.solPriceUsdc).toBe('120.000000');
    } finally {
      ctx.price = price;
    }
  });

  it('concurrent fee claims of two models never count each other’s fees', async () => {
    const graduated = async (): Promise<TestModel> => {
      const tm = await createTestModel(ctx, 'curve');
      await graduate(ctx, tm);
      expect((await runSettlement(ctx, await open(tm.model._id))).state).toBe('done');
      return tm;
    };
    const models = [await graduated(), await graduated()];
    const fees = new Map(models.map((tm, i) => [tm.mint.toBase58(), 1_000n * BigInt(i + 1)]));
    const docs: SettlementDoc[] = [];
    for (const tm of models) {
      const doc = await open(tm.model._id);
      await runSteps(ctx, doc, stepsThrough('buyAndLock'));
      docs.push(doc);
    }
    const before = await Promise.all(
      models.map(async (tm) => (await Models.findById(tm.model._id).lean())?.token),
    );

    const original = ctx.chain.claimPositionFee.bind(ctx.chain);
    const claim = vi
      .spyOn(ctx.chain, 'claimPositionFee')
      .mockImplementation(async (keeper, mint, position, opts) => {
        const result = await original(keeper, mint, position, opts);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const owner = keeper.publicKey;
        ctx.chain.setSol(
          owner,
          (await ctx.chain.solBalance(owner)) + (fees.get(mint.toBase58()) ?? 0n),
        );
        return result;
      });
    try {
      await Promise.all(docs.map((doc) => compound(ctx, doc)));
    } finally {
      claim.mockRestore();
    }

    for (const [i, tm] of models.entries()) {
      const after = (await Models.findById(tm.model._id).lean())?.token;
      const gained =
        (after?.pendingCompoundLamports ?? 0n) - (before[i]?.pendingCompoundLamports ?? 0n);
      expect(gained).toBe(fees.get(tm.mint.toBase58()));
    }
  });

  it('MAX_PAYOUT_USDC_PER_RUN caps the whole run; the rest carries over', async () => {
    const models = [await createTestModel(ctx), await createTestModel(ctx)];
    const start = nextHour();
    for (const { model } of models) await addRequest(model._id, micro(10), start);
    await onlyRun(models);
    const cap = ctx.config.maxPayoutMicroUsdc;
    ctx.config.maxPayoutMicroUsdc = micro(12);
    try {
      await createOrchestrator(ctx).run(periodFromStart(start));
    } finally {
      ctx.config.maxPayoutMicroUsdc = cap;
    }
    const docs = await Settlements.find({
      periodStart: start,
      modelId: { $in: models.map((m) => m.model._id) },
    });
    expect(docs.map((d) => d.state)).toEqual(['done', 'done']);
    const paid = docs.map((d) => d.provider.amountMicroUsdc).sort(asc);
    expect(paid).toEqual([micro(3), micro(9)]);
    const carried = docs.map((d) => d.provider.carryOverMicroUsdc).sort(asc);
    expect(carried).toEqual([0n, micro(6)]);
  });

  it('a run budget left below the minimum payout carries the whole share over', async () => {
    const models = [await createTestModel(ctx), await createTestModel(ctx)];
    const start = nextHour();
    for (const { model } of models) await addRequest(model._id, micro(10), start);
    await onlyRun(models);
    const cap = ctx.config.maxPayoutMicroUsdc;
    ctx.config.maxPayoutMicroUsdc = 9_500_000n;
    try {
      await createOrchestrator(ctx).run(periodFromStart(start));
    } finally {
      ctx.config.maxPayoutMicroUsdc = cap;
    }
    const docs = await Settlements.find({
      periodStart: start,
      modelId: { $in: models.map((m) => m.model._id) },
    });
    expect(docs.map((d) => d.provider.amountMicroUsdc).sort(asc)).toEqual([0n, micro(9)]);
    expect(docs.every((d) => d.state === 'done')).toBe(true);
  });
});
