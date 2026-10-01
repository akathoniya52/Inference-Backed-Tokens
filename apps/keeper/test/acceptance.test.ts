import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { FakeChainTx } from '@ibt/chain/testing';
import { Leases, Models, Settlements, Users, type Types } from '@ibt/db';
import { solToLamports } from '@ibt/shared';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFloatMonitor } from '../src/jobs/floatMonitor.js';
import { createOrchestrator } from '../src/settlement/orchestrator.js';
import { periodFromStart } from '../src/settlement/period.js';
import {
  addRequest,
  createTestModel,
  makeKeeperCtx,
  micro,
  type TestKeeperCtx,
} from './helpers.js';

const KEEPER_DIR = fileURLToPath(new URL('..', import.meta.url));
const PERIOD_START = '2026-03-01T12:00:00.000Z';
const PERIOD = periodFromStart(new Date(PERIOD_START));
const CHILD_TIMEOUT_MS = 90_000;

function childMongoUri(ctx: TestKeeperCtx): string {
  const url = new URL(inject('mongoUri'));
  url.pathname = `/${ctx.db.name}`;
  return url.toString();
}

const running = new Set<ChildProcess>();

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * `settle-once --chain fake` as its own process. Runs `node --import tsx` directly (not
 * through pnpm/tsx wrappers) so SIGKILL hits the process that does the work.
 */
function settleOnce(env: Record<string, string>): {
  child: ChildProcess;
  done: Promise<ChildResult>;
} {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--conditions=development',
      'src/cli/settle-once.ts',
      '--chain',
      'fake',
      '--period-start',
      PERIOD_START,
    ],
    { cwd: KEEPER_DIR, env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'pipe' },
  );
  running.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<ChildResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      running.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, done };
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('acceptance: keeper killed mid-settlement (spec L599)', () => {
  let ctx: TestKeeperCtx;
  let env: Record<string, string>;
  let modelId: Types.ObjectId;

  beforeAll(async () => {
    ctx = await makeKeeperCtx();
    const keeper = Keypair.generate();
    const treasury = Keypair.generate();
    env = {
      CLUSTER: 'devnet',
      RPC_URL: 'http://127.0.0.1:8899',
      CHAIN_MODE: 'fake',
      USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      DBC_CONFIG: Keypair.generate().publicKey.toBase58(),
      DAMM_V2_FEE_CONFIG: Keypair.generate().publicKey.toBase58(),
      TREASURY_WALLET: treasury.publicKey.toBase58(),
      TREASURY_SECRET_KEY: bs58.encode(treasury.secretKey),
      KEEPER_SECRET_KEY: bs58.encode(keeper.secretKey),
      MONGODB_URI: childMongoUri(ctx),
      MAX_SLICE_SOL_PER_RUN: '2',
      MAX_PAYOUT_USDC_PER_RUN: '500',
      FLOAT_MIN_SOL: '0.5',
      JUPITER_PRICE_URL: 'http://127.0.0.1:9/price',
      LOG_LEVEL: 'error',
    };

    const providerWallet = Keypair.generate().publicKey;
    const provider = await Users.create({
      wallet: providerWallet.toBase58(),
      role: 'provider',
      depositRef: 'KPACC001',
    });
    const mint = Keypair.generate().publicKey;
    const pool = await ctx.chain.addPersistedPool({
      mint,
      config: Keypair.generate().publicKey,
      creator: providerWallet,
    });
    const model = await Models.create({
      providerId: provider._id,
      slug: 'acceptance-kill',
      name: 'Acceptance kill',
      upstream: { baseUrl: 'http://127.0.0.1:4010', modelName: 'mock', apiKeyEnc: 'enc' },
      pricing: { inputPerMTokMicroUsdc: 1_000_000n, outputPerMTokMicroUsdc: 2_000_000n },
      token: { status: 'curve', mint: mint.toBase58(), dbcPool: pool.toBase58(), symbol: 'KILL' },
    });
    modelId = model._id;
    await addRequest(modelId, micro(10), new Date(PERIOD.periodStart.getTime() + 60_000));
  });

  afterAll(async () => {
    for (const child of running) child.kill('SIGKILL');
    await ctx.close();
  });

  const txsOf = async (settlementId: string, method: string): Promise<FakeChainTx[]> =>
    ctx.chain.landedTxs({ settlementRef: settlementId, method });

  it(
    'SIGKILL after the provider transfer landed, a second process resumes with no extra payment',
    { timeout: 180_000 },
    async () => {
      const started = Date.now();
      const first = settleOnce({
        ...env,
        SETTLE_ONCE_PAUSE_AFTER_STEP: 'payProvider',
        SETTLE_ONCE_PAUSE_MS: '60000',
      });
      const paid = await waitFor(async () => {
        const doc = await Settlements.findOne({ modelId }).lean();
        return doc?.lastCompletedState === 'paid_provider' ? doc : null;
      }, CHILD_TIMEOUT_MS);
      const settlementId = paid._id.toHexString();
      expect(await txsOf(settlementId, 'transferUsdc')).toHaveLength(1);
      expect(first.child.kill('SIGKILL')).toBe(true);
      const killed = await first.done;
      expect(killed.signal).toBe('SIGKILL');
      expect(await txsOf(settlementId, 'curveBuy')).toHaveLength(0);

      // The killed process still holds the keeper lease (TTL 90 s); expire it as a restart
      // after the TTL would find it, instead of sleeping 90 s.
      await Leases.updateMany({}, { $set: { expiresAt: new Date(0) } });

      const second = await settleOnce(env).done;
      expect(second.stderr).toBe('');
      expect(second.code).toBe(0);
      const summary = JSON.parse(second.stdout.trim()) as {
        chain: string;
        settlements: { settlementId?: string; state?: string; resumed?: boolean }[];
      };
      expect(summary.chain).toBe('fake');
      expect(summary.settlements).toContainEqual(
        expect.objectContaining({ settlementId, state: 'done', resumed: true }),
      );

      const saved = await Settlements.findById(paid._id).lean();
      expect(saved).toMatchObject({ state: 'done', lastCompletedState: 'done', pendingTx: null });
      const transfers = await txsOf(settlementId, 'transferUsdc');
      const buys = await txsOf(settlementId, 'curveBuy');
      expect(transfers).toHaveLength(1);
      expect(buys).toHaveLength(1);
      expect(saved?.provider.txSignature).toBe(transfers[0]?.signature);
      expect(saved?.liquidity.buyTxSignature).toBe(buys[0]?.signature);
      expect(await ctx.chain.landedTxs({ method: 'transferUsdc' })).toHaveLength(1);
      expect(await Settlements.countDocuments({ modelId })).toBe(1);
      ctx.logger.info({ ms: Date.now() - started }, 'kill test finished');
    },
  );
});

describe('acceptance: alerts (spec L602)', () => {
  let ctx: TestKeeperCtx;

  beforeAll(async () => {
    ctx = await makeKeeperCtx();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('a forced non-retryable settlement failure ends failed with an error alert', async () => {
    ctx.alerter.alerts.length = 0;
    const { model } = await createTestModel(ctx, 'curve');
    await addRequest(model._id, micro(10), new Date(PERIOD.periodStart.getTime() + 60_000));
    // Treasury holds no USDC: the payout fails with "insufficient balance", which is not retryable.
    ctx.chain.setUsdc(ctx.treasury.publicKey, 0n);

    const outcomes = await createOrchestrator(ctx).run(PERIOD);
    const doc = await Settlements.findOne({ modelId: model._id }).lean();
    expect(doc).toMatchObject({ state: 'failed', attempts: 1 });
    expect(doc?.error).toMatch(/^payProvider: /);
    expect(outcomes).toContainEqual(expect.objectContaining({ model: model.slug }));
    expect(await ctx.chain.landedTxs({ method: 'transferUsdc' })).toHaveLength(0);
    expect(ctx.alerter.alerts).toEqual([
      expect.objectContaining({
        level: 'error',
        title: 'settlement failed',
        body: expect.objectContaining({
          settlementId: doc?._id.toHexString(),
          step: 'payProvider',
        }) as unknown,
      }),
    ]);
  });

  it('a chain send that keeps failing exhausts its retries, then fails with one alert', async () => {
    ctx.alerter.alerts.length = 0;
    const { model } = await createTestModel(ctx, 'curve');
    const period = periodFromStart(new Date(PERIOD.periodEnd));
    await addRequest(model._id, micro(10), new Date(period.periodStart.getTime() + 60_000));
    ctx.chain.setUsdc(ctx.treasury.publicKey, micro(1_000));
    ctx.chain.failNext('transferUsdc', 3);

    await createOrchestrator(ctx).run(period);
    const doc = await Settlements.findOne({ modelId: model._id }).lean();
    expect(doc).toMatchObject({ state: 'failed', attempts: 3 });
    expect(ctx.alerter.alerts).toHaveLength(1);
    expect(ctx.alerter.alerts[0]).toMatchObject({ level: 'error', title: 'settlement failed' });
  });

  it('floatMonitor alerts when keeper SOL is below FLOAT_MIN_SOL', async () => {
    ctx.alerter.alerts.length = 0;
    const monitor = createFloatMonitor(ctx, { floatMinLamports: solToLamports('0.5') });
    ctx.chain.setUsdc(ctx.treasury.publicKey, micro(1_000_000));

    ctx.chain.setSol(ctx.keeper.publicKey, solToLamports('0.6'));
    expect((await monitor.tick()).alerts).toEqual([]);
    expect(ctx.alerter.alerts).toHaveLength(0);

    ctx.chain.setSol(ctx.keeper.publicKey, solToLamports('0.1'));
    const report = await monitor.tick();
    expect(report.alerts).toEqual(['keeper float below FLOAT_MIN_SOL']);
    expect(ctx.alerter.alerts).toEqual([
      {
        level: 'warn',
        title: 'keeper float below FLOAT_MIN_SOL',
        body: {
          keeper: ctx.keeper.publicKey.toBase58(),
          balanceSol: '0.1',
          minSol: '0.5',
        },
      },
    ]);
  });
});
