import { Settlements, Users, credit } from '@ibt/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env.js';
import { createReconcileJob } from '../src/jobs/reconcile.js';
import { runSettlement } from '../src/settlement/engine.js';
import { periodFromStart } from '../src/settlement/period.js';
import { lease } from '../src/settlement/steps.js';
import {
  addRequest,
  createTestModel,
  makeKeeperCtx,
  micro,
  type TestKeeperCtx,
} from './helpers.js';

const HOUR = 3_600_000;

describe('nightly reconciliation', () => {
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

  it('defaults RECONCILE_CRON to 03:00 UTC nightly', () => {
    const env = loadEnv({
      CLUSTER: 'devnet',
      RPC_URL: 'http://127.0.0.1:8899',
      USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      DBC_CONFIG: 'x',
      DAMM_V2_FEE_CONFIG: 'x',
      TREASURY_WALLET: 'x',
      MONGODB_URI: 'mongodb://localhost:27017/ibt',
      JUPITER_PRICE_URL: 'http://127.0.0.1:1/price',
    });
    expect(env.RECONCILE_CRON).toBe('0 3 * * *');
  });

  it('detects injected balance drift, fixes it from the ledger and alerts', async () => {
    const user = await Users.create({
      wallet: 'ReconWallet111111111111111111111111111111111',
      role: 'consumer',
      depositRef: 'RECON001',
    });
    await credit(user._id, micro(5), { txSignature: 'deposit-sig-1' });
    const clean = await Users.create({
      wallet: 'ReconWallet222222222222222222222222222222222',
      role: 'consumer',
      depositRef: 'RECON002',
    });
    await credit(clean._id, micro(3), { txSignature: 'deposit-sig-2' });
    await Users.updateOne({ _id: user._id }, { $set: { balanceMicroUsdc: micro(7) } });

    const report = await createReconcileJob(ctx).tick();
    expect(report.usersChecked).toBe(2);
    expect(report.drift).toEqual([
      {
        userId: user._id.toHexString(),
        field: 'balance',
        cachedMicroUsdc: micro(7),
        ledgerMicroUsdc: micro(5),
        fixed: true,
      },
    ]);
    expect((await Users.findById(user._id).lean())?.balanceMicroUsdc).toBe(micro(5));
    expect((await Users.findById(clean._id).lean())?.balanceMicroUsdc).toBe(micro(3));
    expect(ctx.alerter.alerts).toEqual([
      expect.objectContaining({ level: 'warn', title: 'balance drift' }),
    ]);

    expect((await createReconcileJob(ctx).tick()).drift).toEqual([]);
  });

  it('checks every settlement signature of the last 48 h and alerts on one that did not land', async () => {
    const now = new Date('2026-07-10T12:00:00Z');
    ctx.clock.set(now);
    const { model } = await createTestModel(ctx, 'curve');
    const start = new Date(now.getTime() - 5 * HOUR);
    await addRequest(model._id, micro(10), start);
    const doc = await lease(ctx, { modelId: model._id, ...periodFromStart(start) });
    if (!doc) throw new Error('lease expected');
    const done = await runSettlement(ctx, doc);
    expect(done.state).toBe('done');

    const clean = await createReconcileJob(ctx).tick();
    expect(clean.signaturesChecked).toBe(2);
    expect(clean.badSignatures).toEqual([]);
    expect(ctx.alerter.alerts).toHaveLength(0);

    await Settlements.updateOne(
      { _id: doc._id },
      { $set: { 'liquidity.buyTxSignature': 'neverLandedSig' } },
    );
    const old = await Settlements.create({
      modelId: model._id,
      ...periodFromStart(new Date(now.getTime() - 72 * HOUR)),
      state: 'done',
      provider: { txSignature: 'tooOldToCheck' },
    });
    const report = await createReconcileJob(ctx).tick();
    expect(report.signaturesChecked).toBe(2);
    expect(report.badSignatures).toEqual([
      {
        settlementId: doc._id.toHexString(),
        field: 'liquidity.buyTxSignature',
        signature: 'neverLandedSig',
        status: 'unknown',
      },
    ]);
    expect(ctx.alerter.alerts).toEqual([
      expect.objectContaining({
        level: 'error',
        title: 'settlement signatures not landed',
        body: expect.objectContaining({ count: 1 }) as unknown,
      }),
    ]);
    expect(
      ctx.chain.calls.some((c) => c.method === 'signatureStatus' && c.args[0] === 'tooOldToCheck'),
    ).toBe(false);
    expect(old.state).toBe('done');
  });
});
