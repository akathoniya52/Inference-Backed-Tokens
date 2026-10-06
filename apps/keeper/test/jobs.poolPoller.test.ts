import { deriveDammPool } from '@ibt/chain';
import { Models, PoolSnapshots } from '@ibt/db';
import type { PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createPoolPoller } from '../src/jobs/poolPoller.js';
import { createTestModel, makeKeeperCtx, type TestKeeperCtx } from './helpers.js';

const THRESHOLD = 1_000n;

describe('poolPoller + migrationCrank', () => {
  let ctx: TestKeeperCtx;

  beforeAll(async () => {
    ctx = await makeKeeperCtx();
    ctx.chain.migrateWhen(THRESHOLD);
    ctx.chain.setSol(ctx.keeper.publicKey, 1_000_000n);
  });

  afterAll(async () => {
    await ctx.close();
  });

  const migrateCalls = (pool: PublicKey) =>
    ctx.chain.calls.filter((c) => c.method === 'migrate' && (c.args[1] as PublicKey).equals(pool))
      .length;

  async function completeCurve(pool: PublicKey): Promise<void> {
    await ctx.chain.curveBuy(ctx.keeper, pool, THRESHOLD);
  }

  it('writes a snapshot for every curve model and ignores models without a token', async () => {
    const { model, pool } = await createTestModel(ctx, 'curve');
    const { model: noToken } = await createTestModel(ctx, 'none');
    const poller = createPoolPoller(ctx);

    await poller.tick();

    const snaps = await PoolSnapshots.find({ modelId: model._id }).lean();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      pool: pool?.toBase58(),
      quoteReserve: '0',
      progress: 0,
      isMigrated: false,
      totalTradingQuoteFee: '0',
    });
    expect(snaps[0]?.ts).toEqual(ctx.clock.now());
    expect(await PoolSnapshots.countDocuments({ modelId: noToken._id })).toBe(0);
  });

  it('complete curve: exactly one migrate across two ticks, then graduates', async () => {
    const { model, pool, mint } = await createTestModel(ctx, 'curve');
    if (!pool) throw new Error('pool expected');
    await completeCurve(pool);
    const poller = createPoolPoller(ctx);

    await Promise.all([poller.tick(), poller.tick()]);
    expect(migrateCalls(pool)).toBe(1);
    const afterMigrate = await Models.findById(model._id).lean();
    expect(afterMigrate?.token.migrationSignature).toEqual(expect.any(String));
    expect(afterMigrate?.token.status).toBe('curve');

    await poller.tick();
    expect(migrateCalls(pool)).toBe(1);
    const graduated = await Models.findById(model._id).lean();
    expect(graduated?.token.status).toBe('graduated');
    expect(graduated?.token.dammV2Pool).toBe(deriveDammPool(mint).toBase58());

    const last = await PoolSnapshots.findOne({ modelId: model._id }).sort({ ts: -1, _id: -1 });
    expect(last?.isMigrated).toBe(true);
    expect(last?.progress).toBe(1);

    await poller.tick();
    expect(migrateCalls(pool)).toBe(1);
    expect(await PoolSnapshots.countDocuments({ modelId: model._id })).toBe(3);
  });

  it('signed-but-unlanded migrate is not resent until its blockhash expires', async () => {
    const { model, pool } = await createTestModel(ctx, 'curve');
    if (!pool) throw new Error('pool expected');
    await completeCurve(pool);
    const poller = createPoolPoller(ctx);
    ctx.setBlockHeight(0);
    ctx.chain.crashAfter('migrate');

    await poller.tick();
    const pending = await Models.findById(model._id).lean();
    expect(pending?.token.migrationSignature).toEqual(expect.any(String));

    await poller.tick();
    expect(migrateCalls(pool)).toBe(1);

    ctx.setBlockHeight(Number.MAX_SAFE_INTEGER);
    await poller.tick();
    expect(migrateCalls(pool)).toBe(2);
    await poller.tick();
    expect((await Models.findById(model._id).lean())?.token.status).toBe('graduated');
    expect(migrateCalls(pool)).toBe(2);
  });

  it('a migration signature stored while the poller signs aborts its send', async () => {
    const { model, pool } = await createTestModel(ctx, 'curve');
    if (!pool) throw new Error('pool expected');
    await completeCurve(pool);
    const poller = createPoolPoller(ctx);
    const migrate = ctx.chain.migrate.bind(ctx.chain);
    vi.spyOn(ctx.chain, 'migrate').mockImplementationOnce(async (keeper, address, opts) => {
      await Models.updateOne(
        { _id: model._id },
        { $set: { 'token.migrationSignature': 'sigSettlementMigrate' } },
      );
      return migrate(keeper, address, opts);
    });

    await poller.tick();
    expect(await ctx.chain.landedTxs({ method: 'migrate', to: pool.toBase58() })).toHaveLength(0);
    expect((await Models.findById(model._id).lean())?.token.migrationSignature).toBe(
      'sigSettlementMigrate',
    );
  });
});
