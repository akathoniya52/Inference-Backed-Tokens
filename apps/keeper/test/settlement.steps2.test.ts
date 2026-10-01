import { FakePriceSource, deriveDammPool, type AddAndLockInput } from '@ibt/chain';
import { FAKE_TOKENS_PER_LAMPORT, type FakeChainMethod } from '@ibt/chain/testing';
import { Models, Requests, Settlements, Types, type SettlementDoc } from '@ibt/db';
import { PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { periodFromStart } from '../src/settlement/period.js';
import {
  LIQUIDITY_STEPS,
  PROVIDER_STEPS,
  buyAndLock,
  convert,
  convertSlice,
  lease,
  runSteps,
} from '../src/settlement/steps.js';
import { createTestModel, makeKeeperCtx, micro, type TestKeeperCtx } from './helpers.js';

const HOUR = 3_600_000;
const P0 = new Date('2026-03-01T10:00:00Z');
const at = (hours: number) => new Date(P0.getTime() + hours * HOUR);
/** 10 USDC revenue → 2 USDC slice → 13_333_333 lamports at 150 USD/SOL. */
const SLICE_LAMPORTS = 13_333_333n;
const DEFAULT_THRESHOLD = 10_000_000_000n;
/** Steps 2–5; `compound` and `finalize` are covered by the engine and suite tests. */
const STEPS_2_TO_5 = [...PROVIDER_STEPS, ...LIQUIDITY_STEPS];
let reqSeq = 0;

describe('settlement steps 4–5', () => {
  let ctx: TestKeeperCtx;

  beforeAll(async () => {
    ctx = await makeKeeperCtx();
    ctx.chain.setUsdc(ctx.treasury.publicKey, micro(1_000_000));
    ctx.chain.setSol(ctx.keeper.publicKey, 1_000_000_000_000n);
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function addRequest(modelId: Types.ObjectId, cost: bigint, createdAt: Date) {
    reqSeq += 1;
    await new Requests({
      userId: new Types.ObjectId(),
      apiKeyId: new Types.ObjectId(),
      modelId,
      requestId: `req2-${reqSeq}`,
      status: 'success',
      costMicroUsdc: cost,
      createdAt,
    }).save({ timestamps: false });
  }

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

  const token = async (modelId: Types.ObjectId) => {
    const model = await Models.findById(modelId).lean();
    if (!model) throw new Error('model vanished');
    return model.token;
  };

  const callsOf = (method: FakeChainMethod) => ctx.chain.calls.filter((c) => c.method === method);
  const landed = (doc: SettlementDoc) =>
    ctx.chain.landedTxs({ settlementRef: doc._id.toHexString() });

  it('convertSlice spends compound first, caps the rest and carries the unspent USDC', () => {
    const priceMicro = 150_000_000n;
    expect(
      convertSlice({
        usdcMicro: micro(2),
        compoundLamports: 0n,
        priceMicro,
        maxLamports: 10n ** 12n,
      }),
    ).toEqual({ lamports: SLICE_LAMPORTS, compoundLeft: 0n, carryMicro: 0n });
    expect(
      convertSlice({
        usdcMicro: micro(2),
        compoundLamports: 3n,
        priceMicro,
        maxLamports: 5_000_003n,
      }),
    ).toEqual({ lamports: 5_000_003n, compoundLeft: 0n, carryMicro: 1_250_000n });
    expect(
      convertSlice({ usdcMicro: micro(2), compoundLamports: 9n, priceMicro, maxLamports: 4n }),
    ).toEqual({ lamports: 4n, compoundLeft: 5n, carryMicro: micro(2) });
    expect(
      convertSlice({ usdcMicro: 0n, compoundLamports: 0n, priceMicro, maxLamports: 4n }),
    ).toEqual({ lamports: 0n, compoundLeft: 0n, carryMicro: 0n });
  });

  it('curve: converts at the stored rate, buys, adds the tokens to escrow and ends locked', async () => {
    const { model, pool } = await createTestModel(ctx, 'curve');
    const doc = await open(model._id);
    await runSteps(ctx, doc, STEPS_2_TO_5);

    const saved = await reload(doc);
    expect(saved.state).toBe('locked');
    expect(saved.liquidity).toMatchObject({
      phase: 'curve',
      solPriceUsdc: '150.000000',
      solLamports: SLICE_LAMPORTS,
      solAddedLamports: SLICE_LAMPORTS,
      tokensBaseUnits: SLICE_LAMPORTS * FAKE_TOKENS_PER_LAMPORT,
      migrationSignature: null,
      lockTxSignature: null,
    });
    expect(saved.liquidity.buyTxSignature).toEqual(expect.any(String));
    expect(saved.pendingTx).toBeNull();
    const buy = callsOf('curveBuy').at(-1);
    expect(buy?.args[1]).toEqual(pool);
    expect(buy?.args[2]).toBe(SLICE_LAMPORTS);
    expect((await token(model._id)).escrowBaseUnits).toBe(SLICE_LAMPORTS * FAKE_TOKENS_PER_LAMPORT);
    expect((await landed(doc)).map((t) => t.method)).toEqual(['transferUsdc', 'curveBuy']);
  });

  it('dust slice → sliceCarryOverMicroUsdc grows, zero buy calls, run finishes with phase none', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    const price = ctx.price;
    ctx.price = new FakePriceSource(5_000_000_000);
    const buysBefore = callsOf('curveBuy').length;
    try {
      const first = await open(model._id);
      await runSteps(ctx, first, STEPS_2_TO_5);
      const s1 = await reload(first);
      expect(s1.state).toBe('done');
      expect(s1.liquidity.phase).toBe('none');
      expect(s1.liquidity.solLamports).toBe(0n);
      expect(s1.provider.txSignature).toEqual(expect.any(String));
      expect((await token(model._id)).sliceCarryOverMicroUsdc).toBe(micro(2));

      const second = await open(model._id, at(1));
      await runSteps(ctx, second, STEPS_2_TO_5);
      expect((await reload(second)).state).toBe('done');
      expect((await token(model._id)).sliceCarryOverMicroUsdc).toBe(micro(4));
    } finally {
      ctx.price = price;
    }
    expect(callsOf('curveBuy').length).toBe(buysBefore);

    const third = await open(model._id, at(2));
    await runSteps(ctx, third, STEPS_2_TO_5);
    const s3 = await reload(third);
    expect(s3.state).toBe('locked');
    expect(s3.liquidity.solLamports).toBe(40_000_000n);
    expect((await token(model._id)).sliceCarryOverMicroUsdc).toBe(0n);
  });

  it('caps the run at MAX_SLICE_SOL_PER_RUN and carries the excess slice over', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    const doc = await open(model._id);
    const cap = ctx.config.maxSliceLamports;
    ctx.config.maxSliceLamports = 5_000_000n;
    try {
      await runSteps(ctx, doc, STEPS_2_TO_5);
    } finally {
      ctx.config.maxSliceLamports = cap;
    }
    const saved = await reload(doc);
    expect(saved.liquidity.solLamports).toBe(5_000_000n);
    expect(callsOf('curveBuy').at(-1)?.args[2]).toBe(5_000_000n);
    expect((await token(model._id)).sliceCarryOverMicroUsdc).toBe(1_250_000n);
  });

  it('stored landed pendingTx on curveBuy → resume records it without a second buy', async () => {
    const { model } = await createTestModel(ctx, 'curve');
    const doc = await open(model._id);
    ctx.chain.crashAfterLand('curveBuy');
    await expect(runSteps(ctx, doc, STEPS_2_TO_5)).rejects.toThrow(/landed/);
    const crashed = await reload(doc);
    expect(crashed.state).toBe('converted');
    expect(crashed.pendingTx?.step).toBe('buyAndLock:curveBuy');
    const landedSig = crashed.pendingTx?.signature;
    const buys = callsOf('curveBuy').length;

    await runSteps(ctx, crashed, STEPS_2_TO_5);
    const saved = await reload(doc);
    expect(callsOf('curveBuy').length).toBe(buys);
    expect(saved.state).toBe('locked');
    expect(saved.liquidity.buyTxSignature).toBe(landedSig);
    expect(saved.liquidity.tokensBaseUnits).toBe(SLICE_LAMPORTS * FAKE_TOKENS_PER_LAMPORT);
    expect(saved.pendingTx).toBeNull();
    expect((await token(model._id)).escrowBaseUnits).toBe(SLICE_LAMPORTS * FAKE_TOKENS_PER_LAMPORT);
    expect((await landed(doc)).filter((t) => t.method === 'curveBuy')).toHaveLength(1);
  });

  it('no token: convert and buyAndLock skip without chain calls', async () => {
    const { model } = await createTestModel(ctx);
    const doc = await open(model._id);
    await runSteps(ctx, doc, PROVIDER_STEPS);
    const callsBefore = ctx.chain.calls.length;
    await runSteps(ctx, doc, STEPS_2_TO_5);

    const saved = await reload(doc);
    expect(saved.state).toBe('locked');
    expect(saved.liquidity.phase).toBe('none');
    expect(saved.liquidity.solLamports).toBe(0n);
    expect(saved.liquidity.buyTxSignature).toBeNull();
    expect(ctx.chain.calls.length).toBe(callsBefore);
  });

  it('curve completes → migrates in the same run; graduated runs pair escrow, then swap half, add and lock', async () => {
    const { model, pool, mint } = await createTestModel(ctx, 'curve');
    if (!pool) throw new Error('pool expected');
    const threshold = 10_000_000n;
    const leftover = SLICE_LAMPORTS - threshold;
    ctx.chain.migrateWhen(threshold);
    try {
      const s0 = await open(model._id);
      await runSteps(ctx, s0, STEPS_2_TO_5);
      const r0 = await reload(s0);
      expect(r0.state).toBe('locked');
      expect(r0.liquidity.solAddedLamports).toBe(threshold);
      expect(r0.liquidity.migrationSignature).toEqual(expect.any(String));
      expect(r0.liquidity.lockTxSignature).toBeNull();
      const t0 = await token(model._id);
      expect(t0.migrationSignature).toBe(r0.liquidity.migrationSignature);
      expect(t0.escrowBaseUnits).toBe(threshold * FAKE_TOKENS_PER_LAMPORT);
      expect(t0.pendingCompoundLamports).toBe(leftover);
      expect((await landed(s0)).map((t) => t.method)).toEqual([
        'transferUsdc',
        'curveBuy',
        'migrate',
      ]);

      // Split and convert still see the curve; buyAndLock re-reads the graduated phase.
      const s1 = await open(model._id, at(1));
      await runSteps(ctx, s1, [...PROVIDER_STEPS, { name: 'convert', run: convert }]);
      expect(s1.liquidity.phase).toBe('curve');
      await Models.updateOne(
        { _id: model._id },
        {
          $set: {
            'token.status': 'graduated',
            'token.dammV2Pool': deriveDammPool(mint).toBase58(),
          },
        },
      );
      await buyAndLock(ctx, s1);
      const r1 = await reload(s1);
      const lamports1 = leftover + SLICE_LAMPORTS;
      expect(r1.state).toBe('locked');
      expect(r1.liquidity.phase).toBe('graduated');
      expect(r1.liquidity.solLamports).toBe(lamports1);
      expect(r1.liquidity.swapTxSignature).toBeNull();
      expect(r1.liquidity.addTxSignature).toEqual(expect.any(String));
      expect(r1.liquidity.lockTxSignature).toEqual(expect.any(String));
      expect(r1.liquidity.tokensBaseUnits).toBe(threshold * FAKE_TOKENS_PER_LAMPORT);
      expect(r1.liquidity.solAddedLamports).toBe(threshold);
      const t1 = await token(model._id);
      expect(t1.escrowBaseUnits).toBe(0n);
      expect(t1.pendingCompoundLamports).toBe(lamports1 - threshold);
      expect(t1.keeperPosition).toEqual(expect.any(String));
      const add1 = callsOf('addAndLock').at(-1)?.args[2] as AddAndLockInput;
      expect(add1).toMatchObject({ position: null, lamports: lamports1 });
      expect((await landed(s1)).map((t) => [t.method, t.signature])).toEqual([
        ['transferUsdc', r1.provider.txSignature],
        ['addAndLock', r1.liquidity.addTxSignature],
        ['addAndLock', r1.liquidity.lockTxSignature],
      ]);

      // Escrow is empty: swap half, then add to the same position; a crash before the
      // add lands rebuilds only the add (the swap is recorded and never resent).
      const s2 = await open(model._id, at(2));
      ctx.chain.crashAfter('addAndLock');
      await expect(runSteps(ctx, s2, STEPS_2_TO_5)).rejects.toThrow(/addAndLock/);
      const crashed = await reload(s2);
      expect(crashed.state).toBe('bought');
      expect(crashed.pendingTx?.step).toBe('buyAndLock:addLiquidity');
      await runSteps(ctx, crashed, STEPS_2_TO_5);

      const r2 = await reload(s2);
      const lamports2 = lamports1 - threshold + SLICE_LAMPORTS;
      const swapIn = lamports2 / 2n;
      expect(r2.state).toBe('locked');
      expect(r2.liquidity.swapTxSignature).toEqual(expect.any(String));
      expect(r2.liquidity.tokensBaseUnits).toBe(swapIn * FAKE_TOKENS_PER_LAMPORT);
      expect(r2.liquidity.solAddedLamports).toBe(swapIn);
      expect(r2.pendingTx).toBeNull();
      const add2 = callsOf('addAndLock').at(-1)?.args[2] as AddAndLockInput;
      expect(add2.lamports).toBe(lamports2 - swapIn);
      expect(add2.position?.position.toBase58()).toBe(t1.keeperPosition);
      const t2 = await token(model._id);
      expect(t2.keeperPosition).toBe(t1.keeperPosition);
      expect(t2.escrowBaseUnits).toBe(0n);
      expect(t2.pendingCompoundLamports).toBe(lamports2 - swapIn - swapIn);
      expect((await landed(s2)).map((t) => t.method)).toEqual([
        'transferUsdc',
        'dammSwap',
        'addAndLock',
        'addAndLock',
      ]);
      expect(callsOf('dammSwap').filter((c) => (c.args[1] as PublicKey).equals(mint))).toHaveLength(
        1,
      );
    } finally {
      ctx.chain.migrateWhen(DEFAULT_THRESHOLD);
    }
  });

  it('a lock lost after its add landed fails the step instead of adding twice', async () => {
    const { model, mint } = await createTestModel(ctx, 'curve');
    await Models.updateOne(
      { _id: model._id },
      { $set: { 'token.status': 'graduated', 'token.escrowBaseUnits': 10n ** 12n } },
    );
    ctx.chain.setBalance(ctx.keeper.publicKey, mint, 10n ** 12n);
    ctx.chain.migrateWhen(0n);
    try {
      const pool = (await token(model._id)).dbcPool;
      if (!pool) throw new Error('pool expected');
      await ctx.chain.migrate(ctx.keeper, new PublicKey(pool));
    } finally {
      ctx.chain.migrateWhen(DEFAULT_THRESHOLD);
    }
    expect(await ctx.chain.readDammPool(mint)).not.toBeNull();

    const doc = await open(model._id);
    ctx.chain.crashAfterLand('addAndLock');
    await expect(runSteps(ctx, doc, STEPS_2_TO_5)).rejects.toThrow(/landed/);
    const crashed = await reload(doc);
    expect(crashed.pendingTx?.step).toBe('buyAndLock:addLiquidity');
    const adds = callsOf('addAndLock').length;

    await expect(runSteps(ctx, crashed, STEPS_2_TO_5)).rejects.toThrow(/without its lock/);
    await expect(runSteps(ctx, await reload(doc), STEPS_2_TO_5)).rejects.toThrow(
      /without its lock/,
    );
    expect(callsOf('addAndLock').length).toBe(adds);
    expect((await reload(doc)).pendingTx).not.toBeNull();
  });
});
