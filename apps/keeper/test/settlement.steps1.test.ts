import { Models, Requests, Settlements, Types, type SettlementDoc } from '@ibt/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { periodFromStart, settlementPeriod } from '../src/settlement/period.js';
import {
  PROVIDER_STEPS,
  lease,
  payProvider,
  runSteps,
  split,
  tagAndSum,
} from '../src/settlement/steps.js';
import { createTestModel, makeKeeperCtx, micro, type TestKeeperCtx } from './helpers.js';

const HOUR = 3_600_000;
const P0 = new Date('2026-03-01T10:00:00Z');
let reqSeq = 0;

describe('settlement steps 1–3', () => {
  let ctx: TestKeeperCtx;

  beforeAll(async () => {
    ctx = await makeKeeperCtx();
    ctx.chain.setUsdc(ctx.treasury.publicKey, micro(1_000_000));
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function addRequest(
    modelId: Types.ObjectId,
    cost: bigint,
    createdAt: Date,
    status: 'success' | 'upstream_error' = 'success',
  ) {
    reqSeq += 1;
    await new Requests({
      userId: new Types.ObjectId(),
      apiKeyId: new Types.ObjectId(),
      modelId,
      requestId: `req-${reqSeq}`,
      status,
      costMicroUsdc: cost,
      createdAt,
    }).save({ timestamps: false });
  }

  async function open(modelId: Types.ObjectId, start = P0): Promise<SettlementDoc> {
    const doc = await lease(ctx, { modelId, ...periodFromStart(start) });
    if (!doc) throw new Error('lease expected');
    return doc;
  }

  const reload = async (doc: SettlementDoc) => {
    const fresh = await Settlements.findById(doc._id);
    if (!fresh) throw new Error('settlement vanished');
    return fresh;
  };

  const transfers = () => ctx.chain.calls.filter((c) => c.method === 'transferUsdc').length;

  it('period is [H-1, H) in UTC', () => {
    expect(settlementPeriod(new Date('2026-03-01T11:05:42Z'))).toEqual({
      periodStart: new Date('2026-03-01T10:00:00Z'),
      periodEnd: new Date('2026-03-01T11:00:00Z'),
    });
    expect(() => periodFromStart(new Date('2026-03-01T10:30:00Z'))).toThrow();
  });

  it('lease inserts computing once; a second runner gets null', async () => {
    const { model } = await createTestModel(ctx);
    const doc = await open(model._id);
    expect(doc.state).toBe('computing');
    expect(doc.lastCompletedState).toBe('computing');
    expect(await lease(ctx, { modelId: model._id, ...periodFromStart(P0) })).toBeNull();
  });

  it('tagAndSum tags billable requests up to periodEnd, including orphans from missed hours', async () => {
    const { model } = await createTestModel(ctx);
    const other = await createTestModel(ctx);
    await addRequest(model._id, 2_000_000n, new Date(P0.getTime() + 60_000));
    await addRequest(model._id, 500_000n, new Date(P0.getTime() - 2 * HOUR + 1));
    await addRequest(model._id, 9_000_000n, new Date(P0.getTime() + 60_000), 'upstream_error');
    await addRequest(model._id, 7_000_000n, new Date(P0.getTime() + HOUR));
    await addRequest(other.model._id, 3_000_000n, new Date(P0.getTime() + 60_000));

    const doc = await open(model._id);
    await tagAndSum(ctx, doc);

    expect(doc.revenueMicroUsdc).toBe(2_500_000n);
    expect(doc.requestCount).toBe(2);
    expect(await Requests.countDocuments({ settlementId: doc._id })).toBe(2);
    const orphan = await Requests.findOne({ modelId: model._id, createdAt: { $lt: P0 } }).lean();
    expect(orphan?.settlementId?.equals(doc._id)).toBe(true);
    expect(await Requests.countDocuments({ modelId: other.model._id, settlementId: null })).toBe(1);

    await tagAndSum(ctx, doc);
    expect((await reload(doc)).revenueMicroUsdc).toBe(2_500_000n);
  });

  it('zero revenue → done with phase none and no chain calls', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    const callsBefore = ctx.chain.calls.length;
    const doc = await open(model._id);
    await runSteps(ctx, doc, PROVIDER_STEPS);

    const saved = await reload(doc);
    expect(saved.state).toBe('done');
    expect(saved.lastCompletedState).toBe('done');
    expect(saved.liquidity.phase).toBe('none');
    expect(saved.revenueMicroUsdc).toBe(0n);
    expect(ctx.chain.calls.length).toBe(callsBefore);
  });

  it('split uses the token phase; no token folds liquidity into the provider', async () => {
    const curve = await createTestModel(ctx, 'curve');
    await addRequest(curve.model._id, micro(10), P0);
    const a = await open(curve.model._id);
    await tagAndSum(ctx, a);
    await split(ctx, a);
    expect(a.liquidity.phase).toBe('curve');
    expect(a.provider.amountMicroUsdc).toBe(micro(7));
    expect(a.liquidity.sliceMicroUsdc).toBe(micro(2));
    expect(a.platformMicroUsdc).toBe(micro(1));

    const none = await createTestModel(ctx);
    await addRequest(none.model._id, micro(10), P0);
    const b = await open(none.model._id);
    await tagAndSum(ctx, b);
    await split(ctx, b);
    expect(b.liquidity.phase).toBe('none');
    expect(b.provider.amountMicroUsdc).toBe(micro(9));
    expect(b.liquidity.sliceMicroUsdc).toBe(0n);
    expect(b.platformMicroUsdc).toBe(micro(1));
  });

  it('pays the provider when the accrued amount is at least 1 USDC', async () => {
    const { model, providerWallet } = await createTestModel(ctx, 'curve');
    await addRequest(model._id, micro(10), P0);
    const doc = await open(model._id);
    await runSteps(ctx, doc, PROVIDER_STEPS);

    const saved = await reload(doc);
    expect(saved.state).toBe('paid_provider');
    expect(saved.lastCompletedState).toBe('paid_provider');
    expect(saved.provider.amountMicroUsdc).toBe(micro(7));
    expect(saved.provider.carryOverMicroUsdc).toBe(0n);
    expect(saved.provider.txSignature).toEqual(expect.any(String));
    expect(saved.pendingTx).toBeNull();
    expect(await ctx.chain.usdcBalance(providerWallet)).toBe(micro(7));
    const landed = await ctx.chain.landedTxs({ settlementRef: doc._id.toHexString() });
    expect(landed.map((t) => t.signature)).toEqual([saved.provider.txSignature]);
  });

  it('carries over below 1 USDC, then pays share + carry next period', async () => {
    const { model, providerWallet } = await createTestModel(ctx);
    await addRequest(model._id, 900_000n, P0);
    const before = transfers();
    const first = await open(model._id);
    await runSteps(ctx, first, PROVIDER_STEPS);

    const s1 = await reload(first);
    expect(s1.state).toBe('paid_provider');
    expect(s1.provider.txSignature).toBeNull();
    expect(s1.provider.amountMicroUsdc).toBe(0n);
    expect(s1.provider.carryOverMicroUsdc).toBe(810_000n);
    expect(transfers()).toBe(before);
    expect((await Models.findById(model._id).lean())?.token.carryOverMicroUsdc).toBe(810_000n);

    const P1 = new Date(P0.getTime() + HOUR);
    await addRequest(model._id, 300_000n, P1);
    const second = await open(model._id, P1);
    await runSteps(ctx, second, PROVIDER_STEPS);

    const s2 = await reload(second);
    expect(s2.provider.amountMicroUsdc).toBe(1_080_000n);
    expect(s2.provider.carryOverMicroUsdc).toBe(0n);
    expect(transfers()).toBe(before + 1);
    expect(await ctx.chain.usdcBalance(providerWallet)).toBe(1_080_000n);
    expect((await Models.findById(model._id).lean())?.token.carryOverMicroUsdc).toBe(0n);
  });

  it('caps a payout at MAX_PAYOUT_USDC_PER_RUN and carries the excess', async () => {
    const { model } = await createTestModel(ctx);
    await addRequest(model._id, micro(1000), P0);
    const doc = await open(model._id);
    const cap = ctx.config.maxPayoutMicroUsdc;
    ctx.config.maxPayoutMicroUsdc = micro(500);
    try {
      await runSteps(ctx, doc, PROVIDER_STEPS);
    } finally {
      ctx.config.maxPayoutMicroUsdc = cap;
    }
    const saved = await reload(doc);
    expect(saved.provider.amountMicroUsdc).toBe(micro(500));
    expect(saved.provider.carryOverMicroUsdc).toBe(micro(400));
    expect((await Models.findById(model._id).lean())?.token.carryOverMicroUsdc).toBe(micro(400));
  });

  it('stored landed pendingTx on payProvider → resume records it without a second transfer', async () => {
    const { model, providerWallet } = await createTestModel(ctx, 'curve');
    await addRequest(model._id, micro(10), P0);
    const doc = await open(model._id);
    await tagAndSum(ctx, doc);
    await split(ctx, doc);

    ctx.chain.crashAfterLand('transferUsdc');
    await expect(payProvider(ctx, doc)).rejects.toThrow(/landed/);
    const crashed = await reload(doc);
    expect(crashed.state).toBe('computing');
    const landedSig = crashed.pendingTx?.signature;
    expect(landedSig).toEqual(expect.any(String));
    const before = transfers();

    await runSteps(ctx, crashed, PROVIDER_STEPS);
    const saved = await reload(doc);
    expect(transfers()).toBe(before);
    expect(saved.state).toBe('paid_provider');
    expect(saved.provider.txSignature).toBe(landedSig);
    expect(saved.pendingTx).toBeNull();
    expect(await ctx.chain.landedTxs({ settlementRef: doc._id.toHexString() })).toHaveLength(1);
    expect(await ctx.chain.usdcBalance(providerWallet)).toBe(micro(7));
  });

  it('signed-but-unlanded pendingTx with an expired blockhash is rebuilt once', async () => {
    const { model, providerWallet } = await createTestModel(ctx, 'curve');
    await addRequest(model._id, micro(10), P0);
    const doc = await open(model._id);

    ctx.chain.crashAfter('transferUsdc');
    await expect(runSteps(ctx, doc, PROVIDER_STEPS)).rejects.toThrow();
    const crashed = await reload(doc);
    const staleSig = crashed.pendingTx?.signature;
    expect(staleSig).toEqual(expect.any(String));

    ctx.setBlockHeight(Number.MAX_SAFE_INTEGER);
    await runSteps(ctx, crashed, PROVIDER_STEPS);
    const saved = await reload(doc);
    expect(saved.state).toBe('paid_provider');
    expect(saved.provider.txSignature).not.toBe(staleSig);
    expect(await ctx.chain.landedTxs({ settlementRef: doc._id.toHexString() })).toHaveLength(1);
    expect(await ctx.chain.usdcBalance(providerWallet)).toBe(micro(7));
  });

  it('unresolved pendingTx with a live blockhash fails the step instead of resending', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    await addRequest(model._id, micro(10), P0);
    const doc = await open(model._id);
    ctx.chain.crashAfter('transferUsdc');
    await expect(runSteps(ctx, doc, PROVIDER_STEPS)).rejects.toThrow();
    const before = transfers();

    ctx.setBlockHeight(0);
    try {
      await expect(runSteps(ctx, await reload(doc), PROVIDER_STEPS)).rejects.toThrow(/pendingTx/);
    } finally {
      ctx.setBlockHeight(Number.MAX_SAFE_INTEGER);
    }
    expect(transfers()).toBe(before);
    expect((await reload(doc)).pendingTx).not.toBeNull();
  });

  it.each(['crashAfterLand', 'crashAfter'] as const)(
    'resume with a stored pendingTx (%s) skips tagAndSum and split; a later request stays untagged',
    async (crash) => {
      const { model, providerWallet } = await createTestModel(ctx, 'curve');
      await addRequest(model._id, micro(10), P0);
      const doc = await open(model._id);

      ctx.chain[crash]('transferUsdc');
      await expect(runSteps(ctx, doc, PROVIDER_STEPS)).rejects.toThrow();
      const crashed = await reload(doc);
      expect(crashed.pendingTx).not.toBeNull();
      expect(crashed.revenueMicroUsdc).toBe(micro(10));

      await addRequest(model._id, micro(20), new Date(P0.getTime() + 60_000));
      await runSteps(ctx, crashed, PROVIDER_STEPS);

      const saved = await reload(doc);
      expect(saved.state).toBe('paid_provider');
      expect(saved.revenueMicroUsdc).toBe(micro(10));
      expect(saved.requestCount).toBe(1);
      expect(saved.provider.amountMicroUsdc).toBe(micro(7));
      const landed = await ctx.chain.landedTxs({ settlementRef: doc._id.toHexString() });
      expect(landed).toHaveLength(1);
      expect(landed[0]?.signature).toBe(saved.provider.txSignature);
      expect(landed[0]?.amount).toBe(micro(7).toString());
      expect(await ctx.chain.usdcBalance(providerWallet)).toBe(micro(7));
      expect(await Requests.countDocuments({ modelId: model._id, settlementId: null })).toBe(1);
    },
  );
});
