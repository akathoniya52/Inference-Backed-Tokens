import type { FakeChainMethod } from '@ibt/chain/testing';
import { Models, Settlements, type SettlementDoc, type Types } from '@ibt/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { isRetryable, runSettlement } from '../src/settlement/engine.js';
import { createOrchestrator, mapLimit } from '../src/settlement/orchestrator.js';
import { PendingTxUnresolvedError } from '../src/settlement/pendingTx.js';
import { periodFromStart } from '../src/settlement/period.js';
import {
  LIQUIDITY_STEPS,
  PROVIDER_STEPS,
  doneInvariantViolation,
  lease,
  runSteps,
} from '../src/settlement/steps.js';
import { settlementSummary } from '../src/settlement/summary.js';
import {
  addRequest,
  createTestModel,
  graduate,
  makeKeeperCtx,
  micro,
  type TestKeeperCtx,
} from './helpers.js';

const HOUR = 3_600_000;
const P0 = new Date('2026-04-01T10:00:00Z');
const at = (hours: number) => new Date(P0.getTime() + hours * HOUR);
const FEE_LAMPORTS = 4_200n;
const FEE_TOKENS = 77_000n;

describe('settlement engine and orchestrator', () => {
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

  async function open(modelId: Types.ObjectId, start = P0): Promise<SettlementDoc> {
    await addRequest(modelId, micro(10), start);
    const doc = await lease(ctx, { modelId, ...periodFromStart(start) });
    if (!doc) throw new Error('lease expected');
    return doc;
  }

  const reload = async (doc: SettlementDoc) => {
    const fresh = await Settlements.findById(doc._id);
    if (!fresh) throw new Error('settlement vanished');
    return fresh;
  };

  const callsOf = (method: FakeChainMethod) => ctx.chain.calls.filter((c) => c.method === method);
  const landed = (doc: SettlementDoc) =>
    ctx.chain.landedTxs({ settlementRef: doc._id.toHexString() });

  it('runs every step to done and the done doc satisfies the L375 invariant', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    const doc = await runSettlement(ctx, await open(model._id));
    expect(doc.state).toBe('done');
    expect(doc.lastCompletedState).toBe('done');
    expect(doc.attempts).toBe(0);
    expect(doc.liquidity.claimTxSignature).toBeNull();
    expect(doneInvariantViolation(doc)).toBeNull();
    expect((await landed(doc)).map((t) => t.method)).toEqual(['transferUsdc', 'curveBuy']);
  });

  it('compound: graduated claim adds lamports to pendingCompoundLamports and base fees to escrow', async () => {
    const tm = await createTestModel(ctx, 'curve');
    await graduate(ctx, tm);
    const original = ctx.chain.claimPositionFee.bind(ctx.chain);
    const claim = vi
      .spyOn(ctx.chain, 'claimPositionFee')
      .mockImplementationOnce(async (keeper, mint, position, opts) => {
        const result = await original(keeper, mint, position, opts);
        const owner = keeper.publicKey;
        ctx.chain.setSol(owner, (await ctx.chain.solBalance(owner)) + FEE_LAMPORTS);
        ctx.chain.setBalance(owner, mint, (await ctx.chain.tokenBalance(owner, mint)) + FEE_TOKENS);
        return result;
      });
    try {
      const doc = await runSettlement(ctx, await open(tm.model._id));
      expect(doc.state).toBe('done');
      expect(claim).toHaveBeenCalledTimes(1);
      expect(doc.liquidity.claimTxSignature).toEqual(expect.any(String));
      expect(doc.liquidity.lockTxSignature).toEqual(expect.any(String));
      // 13_333_333 lamports: half swapped, 6_666_666 paired, 1 left over before the fee.
      const token = (await Models.findById(tm.model._id).lean())?.token;
      expect(token?.pendingCompoundLamports).toBe(1n + FEE_LAMPORTS);
      expect(token?.escrowBaseUnits).toBe(FEE_TOKENS);
      expect((await landed(doc)).map((t) => t.method)).toEqual([
        'transferUsdc',
        'dammSwap',
        'addAndLock',
        'addAndLock',
        'claimPositionFee',
      ]);
      expect(settlementSummary(doc).liquidity.claimTx).toBe(doc.liquidity.claimTxSignature);
    } finally {
      claim.mockRestore();
    }
  });

  it('compound: a landed claim is recovered from pendingTx and never sent twice', async () => {
    const tm = await createTestModel(ctx, 'curve');
    await graduate(ctx, tm);
    const doc = await open(tm.model._id);
    ctx.chain.crashAfterLand('claimPositionFee');
    await expect(runSteps(ctx, doc, [...PROVIDER_STEPS, ...LIQUIDITY_STEPS])).resolves.toBe(
      undefined,
    );
    const crashed = await runSettlement(ctx, await reload(doc), { attempts: 1 });
    expect(crashed.state).toBe('failed');
    expect(crashed.pendingTx?.step).toBe('compound:claimPositionFee');
    const claims = callsOf('claimPositionFee').length;

    await Settlements.updateOne(
      { _id: doc._id },
      { $set: { state: crashed.lastCompletedState, error: null } },
    );
    const done = await runSettlement(ctx, await reload(doc));
    expect(done.state).toBe('done');
    expect(done.liquidity.claimTxSignature).toBe(crashed.pendingTx?.signature);
    expect(callsOf('claimPositionFee')).toHaveLength(claims);
  });

  it('retries a failing send with backoff, then succeeds and counts the attempts', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    const doc = await open(model._id);
    const sleep = vi.spyOn(ctx, 'sleep');
    ctx.chain.failNext('transferUsdc', 2);
    try {
      const done = await runSettlement(ctx, doc, { backoffMs: [5, 10] });
      expect(done.state).toBe('done');
      expect(done.attempts).toBe(2);
      expect(done.error).toBeNull();
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5, 10]);
    } finally {
      sleep.mockRestore();
    }
    expect((await landed(doc)).filter((t) => t.method === 'transferUsdc')).toHaveLength(1);
    expect(ctx.alerter.alerts).toHaveLength(0);
  });

  it('three failed attempts → failed with error and attempts, plus an alert', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    const doc = await open(model._id);
    ctx.chain.failNext('curveBuy', 3);
    const failed = await runSettlement(ctx, doc);
    expect(failed.state).toBe('failed');
    expect(failed.lastCompletedState).toBe('converted');
    expect(failed.attempts).toBe(3);
    expect(failed.error).toMatch(/^buyAndLock: /);
    expect(ctx.alerter.alerts).toEqual([
      expect.objectContaining({
        level: 'error',
        title: 'settlement failed',
        body: expect.objectContaining({
          settlementId: doc._id.toHexString(),
          step: 'buyAndLock',
          attempts: 3,
        }) as unknown,
      }),
    ]);
    expect(await runSettlement(ctx, failed)).toBe(failed);
  });

  it('"landed without its lock" fails at once with an alert, never retried', async () => {
    const tm = await createTestModel(ctx, 'curve');
    await graduate(ctx, tm);
    await Models.updateOne(
      { _id: tm.model._id },
      { $set: { 'token.escrowBaseUnits': 10n ** 12n } },
    );
    ctx.chain.setBalance(ctx.keeper.publicKey, tm.mint, 10n ** 12n);
    const doc = await open(tm.model._id);
    ctx.chain.crashAfterLand('addAndLock');
    await expect(runSteps(ctx, doc, [...PROVIDER_STEPS, ...LIQUIDITY_STEPS])).rejects.toThrow();
    const adds = callsOf('addAndLock').length;

    const failed = await runSettlement(ctx, await reload(doc));
    expect(failed.state).toBe('failed');
    expect(failed.attempts).toBe(1);
    expect(failed.error).toMatch(/without its lock/);
    expect(ctx.alerter.alerts).toHaveLength(1);
    expect(callsOf('addAndLock')).toHaveLength(adds);
  });

  it('classifies retryable errors', () => {
    expect(isRetryable(new PendingTxUnresolvedError('payProvider:payout', 'sig'))).toBe(true);
    expect(isRetryable(new Error('block height exceeded: blockhash expired'))).toBe(true);
    expect(isRetryable(new Error('fake chain: insufficient balance'))).toBe(false);
  });

  it('resume on boot finishes a settlement left in paid_provider by an earlier run', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    const doc = await open(model._id);
    await runSteps(ctx, doc, PROVIDER_STEPS);
    expect((await reload(doc)).state).toBe('paid_provider');

    const outcomes = await createOrchestrator(ctx).resume();
    const mine = outcomes.find((o) => 'settlement' in o && o.settlement._id.equals(doc._id));
    expect(mine).toMatchObject({ model: model.slug, resumed: true });
    const saved = await reload(doc);
    expect(saved.state).toBe('done');
    expect((await landed(doc)).map((t) => t.method)).toEqual(['transferUsdc', 'curveBuy']);
  });

  it('an admin-retried failed settlement is executed on the next run before new periods', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    const doc = await open(model._id, at(-5));
    ctx.chain.failNext('curveBuy', 3);
    expect((await runSettlement(ctx, doc)).state).toBe('failed');
    expect((await createOrchestrator(ctx).resume()).some((o) => o.model === model.slug)).toBe(
      false,
    );

    // What POST /api/admin/settlements/:id/retry does: back to the last completed state.
    await Settlements.updateOne({ _id: doc._id }, { $set: { state: 'converted', error: null } });
    await addRequest(model._id, micro(10), at(0));
    const outcomes = await createOrchestrator(ctx).run(periodFromStart(at(0)));
    const mine = outcomes.filter((o) => o.model === model.slug);
    // The resumed period runs first; then every missed hour up to at(0) is opened (KPR-08).
    expect(mine.map((o) => ('settlement' in o ? o.resumed : null))).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect((await reload(doc)).state).toBe('done');
    const fresh = await Settlements.findOne({ modelId: model._id, periodStart: at(0) });
    expect(fresh?.state).toBe('done');
  });

  it('mapLimit never runs more than the limit at once and keeps order', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});
