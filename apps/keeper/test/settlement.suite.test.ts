import type { FakeChainMethod } from '@ibt/chain/testing';
import { Models, Settlements, type SettlementDoc, type Types } from '@ibt/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLease } from '../src/lease.js';
import { runSettlement } from '../src/settlement/engine.js';
import { createOrchestrator } from '../src/settlement/orchestrator.js';
import { periodFromStart } from '../src/settlement/period.js';
import {
  SETTLEMENT_STEPS,
  doneInvariantViolation,
  lease,
  runSteps,
  type NamedStep,
} from '../src/settlement/steps.js';
import {
  addRequest,
  createTestModel,
  graduate,
  makeKeeperCtx,
  micro,
  type TestKeeperCtx,
} from './helpers.js';

const HOUR = 3_600_000;
const BASE = new Date('2026-05-01T00:00:00Z');
/** Every test settles its own hour so runs never share a period. */
let hourSeq = 0;
const nextHour = () => new Date(BASE.getTime() + (hourSeq += 2) * HOUR);
/** 10 USDC revenue → 2 USDC slice → 13_333_333 lamports at 150 USD/SOL. */
const SLICE_LAMPORTS = 13_333_333n;

const stepsThrough = (name: string): NamedStep[] => {
  const end = SETTLEMENT_STEPS.findIndex((s) => s.name === name);
  if (end < 0) throw new Error(`unknown step ${name}`);
  return SETTLEMENT_STEPS.slice(0, end + 1);
};

describe('settlement suite (L589)', () => {
  let ctx: TestKeeperCtx;

  beforeAll(async () => {
    ctx = await makeKeeperCtx();
    ctx.chain.setUsdc(ctx.treasury.publicKey, micro(1_000_000));
    ctx.chain.setSol(ctx.keeper.publicKey, 1_000_000_000_000n);
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function open(modelId: Types.ObjectId, start: Date, revenue = micro(10)) {
    if (revenue > 0n) await addRequest(modelId, revenue, start);
    const doc = await lease(ctx, { modelId, ...periodFromStart(start) });
    if (!doc) throw new Error('lease expected');
    return doc;
  }

  const reload = async (doc: SettlementDoc) => {
    const fresh = await Settlements.findById(doc._id);
    if (!fresh) throw new Error('settlement vanished');
    return fresh;
  };

  const token = async (modelId: Types.ObjectId) => {
    const model = await Models.findById(modelId).lean();
    if (!model) throw new Error('model vanished');
    return model.token;
  };

  const landedMethods = async (doc: SettlementDoc) =>
    (await ctx.chain.landedTxs({ settlementRef: doc._id.toHexString() })).map((t) => t.method);

  const sendsOf = (doc: SettlementDoc, method: FakeChainMethod) =>
    ctx.chain.calls.filter(
      (c) =>
        c.method === method &&
        (c.args.at(-1) as { settlementRef?: string } | undefined)?.settlementRef ===
          doc._id.toHexString(),
    ).length;

  it('walks every transition: computing → paid_provider → converted → bought → locked → done', async () => {
    const tm = await createTestModel(ctx, 'curve');
    await graduate(ctx, tm);
    const doc = await open(tm.model._id, nextHour());
    const seen: string[] = [doc.state];
    const record = (state: string) => {
      if (seen.at(-1) !== state) seen.push(state);
    };
    let current = doc;
    for (const step of SETTLEMENT_STEPS) {
      if (step.name === 'buyAndLock') {
        // Stop between the swap and the add to observe `bought`.
        ctx.chain.crashAfter('addAndLock');
        await expect(step.run(ctx, current)).rejects.toThrow(/addAndLock/);
        current = await reload(doc);
        record(current.state);
      }
      await step.run(ctx, current);
      record((await reload(doc)).state);
    }
    expect(seen).toEqual(['computing', 'paid_provider', 'converted', 'bought', 'locked', 'done']);
    const final = await reload(doc);
    expect(final.liquidity.lockTxSignature).toEqual(expect.any(String));
    expect(final.liquidity.claimTxSignature).toEqual(expect.any(String));
  });

  it.each(['lease', 'tagAndSum', 'payProvider', 'convert', 'buyAndLock', 'compound', 'finalize'])(
    'crash after step %s → resume → exactly one provider transfer and one buy',
    async (crashAfter) => {
      const { model } = await createTestModel(ctx, 'curve');
      const start = nextHour();
      const doc = await open(model._id, start);
      if (crashAfter !== 'lease') await runSteps(ctx, doc, stepsThrough(crashAfter));

      const orchestrator = createOrchestrator(ctx);
      await orchestrator.resume();
      const again = await orchestrator.run(periodFromStart(start));
      expect(again.find((o) => o.model === model.slug)).toEqual({
        model: model.slug,
        skipped: 'already_leased',
      });

      const saved = await reload(doc);
      expect(saved.state).toBe('done');
      expect(await landedMethods(doc)).toEqual(['transferUsdc', 'curveBuy']);
      expect(sendsOf(doc, 'transferUsdc')).toBe(1);
      expect(sendsOf(doc, 'curveBuy')).toBe(1);
    },
  );

  it.each(['transferUsdc', 'curveBuy'] as const)(
    'signed-but-unlanded %s (crashAfter) → re-run rebuilds it once',
    async (method) => {
      const { model } = await createTestModel(ctx, 'curve');
      const doc = await open(model._id, nextHour());
      ctx.chain.crashAfter(method);
      await expect(runSteps(ctx, doc, SETTLEMENT_STEPS)).rejects.toThrow(/crash/);
      const done = await runSettlement(ctx, await reload(doc));
      expect(done.state).toBe('done');
      expect(await landedMethods(doc)).toEqual(['transferUsdc', 'curveBuy']);
    },
  );

  it.each(['transferUsdc', 'curveBuy'] as const)(
    'crash between landing and persist (crashAfterLand %s) → pendingTx resume, no second send',
    async (method) => {
      const { model } = await createTestModel(ctx, 'curve');
      const doc = await open(model._id, nextHour());
      ctx.chain.crashAfterLand(method);
      await expect(runSteps(ctx, doc, SETTLEMENT_STEPS)).rejects.toThrow(/landed/);
      const crashed = await reload(doc);
      const landedSig = crashed.pendingTx?.signature;
      expect(landedSig).toEqual(expect.any(String));
      const sends = sendsOf(doc, method);

      const done = await runSettlement(ctx, crashed);
      expect(done.state).toBe('done');
      expect(sendsOf(doc, method)).toBe(sends);
      expect(await landedMethods(doc)).toEqual(['transferUsdc', 'curveBuy']);
      const recorded =
        method === 'transferUsdc' ? done.provider.txSignature : done.liquidity.buyTxSignature;
      expect(recorded).toBe(landedSig);
      expect(ctx.chain.calls.some((c) => c.method === 'signatureStatus')).toBe(true);
    },
  );

  it('carries a provider share below 1 USDC across two periods, then pays it', async () => {
    const { model, providerWallet } = await createTestModel(ctx);
    const s1 = await runSettlement(ctx, await open(model._id, nextHour(), 500_000n));
    expect(s1.state).toBe('done');
    expect(s1.provider.txSignature).toBeNull();
    expect(s1.provider.carryOverMicroUsdc).toBe(450_000n);
    expect(doneInvariantViolation(s1)).toBeNull();

    const s2 = await runSettlement(ctx, await open(model._id, nextHour(), 700_000n));
    expect(s2.provider.amountMicroUsdc).toBe(1_080_000n);
    expect(s2.provider.carryOverMicroUsdc).toBe(0n);
    expect(await ctx.chain.usdcBalance(providerWallet)).toBe(1_080_000n);
    expect((await token(model._id)).carryOverMicroUsdc).toBe(0n);
  });

  it('caps the slice at maxSliceSolPerRun and carries the rest into the next run', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    const cap = ctx.config.maxSliceLamports;
    ctx.config.maxSliceLamports = 5_000_000n;
    try {
      const s1 = await runSettlement(ctx, await open(model._id, nextHour()));
      expect(s1.state).toBe('done');
      expect(s1.liquidity.solLamports).toBe(5_000_000n);
      expect((await token(model._id)).sliceCarryOverMicroUsdc).toBe(1_250_000n);
    } finally {
      ctx.config.maxSliceLamports = cap;
    }
    const s2 = await runSettlement(ctx, await open(model._id, nextHour()));
    expect(s2.liquidity.solLamports).toBe(SLICE_LAMPORTS + 8_333_333n);
    expect((await token(model._id)).sliceCarryOverMicroUsdc).toBe(0n);
  });

  it('a token that graduates between convert and buy takes the graduated path', async () => {
    const tm = await createTestModel(ctx, 'curve');
    const doc = await open(tm.model._id, nextHour());
    await runSteps(ctx, doc, stepsThrough('convert'));
    expect(doc.liquidity.phase).toBe('curve');
    await graduate(ctx, tm);

    const done = await runSettlement(ctx, await reload(doc));
    expect(done.state).toBe('done');
    expect(done.liquidity.phase).toBe('graduated');
    expect(done.liquidity.buyTxSignature).toBeNull();
    expect(await landedMethods(doc)).toEqual([
      'transferUsdc',
      'dammSwap',
      'addAndLock',
      'addAndLock',
      'claimPositionFee',
    ]);
    expect(doneInvariantViolation(done)).toBeNull();
  });

  it('no token: provider gets 90%, platform 10%, no liquidity sends', async () => {
    const { model, providerWallet } = await createTestModel(ctx);
    const done = await runSettlement(ctx, await open(model._id, nextHour()));
    expect(done.state).toBe('done');
    expect(done.liquidity.phase).toBe('none');
    expect(done.provider.amountMicroUsdc).toBe(micro(9));
    expect(done.platformMicroUsdc).toBe(micro(1));
    expect(done.liquidity.sliceMicroUsdc).toBe(0n);
    expect(await ctx.chain.usdcBalance(providerWallet)).toBe(micro(9));
    expect(await landedMethods(done)).toEqual(['transferUsdc']);
  });

  it('a second concurrent runner fails fast: one settlement per period, one payout', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    const start = nextHour();
    await addRequest(model._id, micro(10), start);
    const [a, b] = await Promise.all([
      createOrchestrator(ctx).run(periodFromStart(start)),
      createOrchestrator(ctx).run(periodFromStart(start)),
    ]);
    const mine = [...a, ...b].filter((o) => o.model === model.slug);
    expect(mine.filter((o) => 'skipped' in o)).toHaveLength(1);
    const docs = await Settlements.find({ modelId: model._id, periodStart: start });
    expect(docs).toHaveLength(1);
    const [doc] = docs;
    if (!doc) throw new Error('settlement expected');
    expect(doc.state).toBe('done');
    expect(await landedMethods(doc)).toEqual(['transferUsdc', 'curveBuy']);

    const leaseOpts = { name: `suite-${start.getTime()}`, logger: ctx.logger };
    const first = createLease({ ...leaseOpts, holder: 'keeper-a' });
    const second = createLease({ ...leaseOpts, holder: 'keeper-b' });
    try {
      expect(await first.tick()).toBe(true);
      expect(await second.tick()).toBe(false);
    } finally {
      await first.stop();
    }
  });

  it('zero-revenue period → done, phase none, no chain calls', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    const calls = ctx.chain.calls.length;
    const done = await runSettlement(ctx, await open(model._id, nextHour(), 0n));
    expect(done.state).toBe('done');
    expect(done.liquidity.phase).toBe('none');
    expect(done.revenueMicroUsdc).toBe(0n);
    expect(ctx.chain.calls.length).toBe(calls);
  });

  it('dust slice → carried over, no buy, done with phase none', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    // 0 lamports to spend: E5 now rejects the absurd price this test used to get dust from.
    const cap = ctx.config.maxSliceLamports;
    ctx.config.maxSliceLamports = 0n;
    try {
      const done = await runSettlement(ctx, await open(model._id, nextHour()));
      expect(done.state).toBe('done');
      expect(done.liquidity.phase).toBe('none');
      expect(done.liquidity.solLamports).toBe(0n);
      expect(await landedMethods(done)).toEqual(['transferUsdc']);
      expect((await token(model._id)).sliceCarryOverMicroUsdc).toBe(micro(2));
    } finally {
      ctx.config.maxSliceLamports = cap;
    }
  });

  it('an orphaned request from a missed hour is settled by the next run', async () => {
    const { model } = await createTestModel(ctx);
    const start = nextHour();
    await addRequest(model._id, micro(3), new Date(start.getTime() - 3 * HOUR));
    const done = await runSettlement(ctx, await open(model._id, start, micro(7)));
    expect(done.revenueMicroUsdc).toBe(micro(10));
    expect(done.requestCount).toBe(2);
    expect(done.provider.amountMicroUsdc).toBe(micro(9));
  });

  it('every done settlement satisfies the L375 invariant', async () => {
    const done = await Settlements.find({ state: 'done' });
    expect(done.length).toBeGreaterThanOrEqual(20);
    expect(done.map(doneInvariantViolation).filter((v) => v !== null)).toEqual([]);
    for (const doc of done) {
      expect(doc.provider.txSignature != null || doc.provider.amountMicroUsdc === 0n).toBe(true);
      if (doc.liquidity.phase !== 'none' && (doc.liquidity.solAddedLamports ?? 0n) > 0n) {
        expect(doc.liquidity.buyTxSignature ?? doc.liquidity.lockTxSignature).toEqual(
          expect.any(String),
        );
      }
    }
  });
});
