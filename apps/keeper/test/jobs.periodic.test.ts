import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Ledger, Models, Settlements, Users, hold, type Types } from '@ibt/db';
import { lamportsToSol } from '@ibt/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createFloatMonitor, expectedPayoutMicro } from '../src/jobs/floatMonitor.js';
import { HEALTH_CHECK_PATH, createHealthCheckJob } from '../src/jobs/healthCheck.js';
import { createHoldExpiryJob } from '../src/jobs/holdExpiry.js';
import { createStatsJob } from '../src/jobs/stats.js';
import {
  addRequest,
  createTestModel,
  makeKeeperCtx,
  micro,
  type TestKeeperCtx,
} from './helpers.js';

const HOUR = 3_600_000;

describe('periodic keeper jobs', () => {
  let ctx: TestKeeperCtx;

  beforeAll(async () => {
    ctx = await makeKeeperCtx();
  });

  beforeEach(() => {
    ctx.alerter.alerts.length = 0;
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('healthCheck', () => {
    let server: Server;
    let apiUrl: string;
    let statuses: number[] = [];
    const seen: { method?: string; url?: string; auth?: string }[] = [];

    beforeAll(async () => {
      server = createServer((req: IncomingMessage, res) => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
        const status = statuses.shift() ?? 200;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status === 200 ? { checked: 2, paused: 0 } : { error: 'x' }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it('POSTs the api health-check endpoint with the admin bearer token', async () => {
      const job = createHealthCheckJob(ctx, { apiUrl, adminToken: 'admin-secret' });
      expect(await job.tick()).toEqual({ status: 'ok', httpStatus: 200 });
      expect(seen.at(-1)).toEqual({
        method: 'POST',
        url: HEALTH_CHECK_PATH,
        auth: 'Bearer admin-secret',
      });
      expect(ctx.alerter.alerts).toHaveLength(0);
    });

    it('alerts on non-2xx and pauses 60 s after three consecutive failures', async () => {
      const job = createHealthCheckJob(ctx, { apiUrl, adminToken: 'admin-secret' });
      statuses = [500, 503, 401];
      const before = seen.length;
      for (const n of [1, 2, 3]) {
        expect(await job.tick()).toMatchObject({ status: 'failed', consecutiveFailures: n });
      }
      expect(ctx.alerter.alerts.map((a) => a.title)).toEqual([
        'health check run failed',
        'health check run failed',
        'health check run failed',
        'health check job paused',
      ]);
      expect(JSON.stringify(ctx.alerter.alerts)).not.toContain('admin-secret');

      expect(await job.tick()).toMatchObject({ status: 'paused' });
      expect(seen.length).toBe(before + 3);
      ctx.clock.advance(60_000);
      expect(await job.tick()).toEqual({ status: 'ok', httpStatus: 200 });
      expect(seen.length).toBe(before + 4);
    });

    it('counts a network error as a failure', async () => {
      const job = createHealthCheckJob(ctx, {
        apiUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        timeoutMs: 1_000,
      });
      expect(await job.tick()).toMatchObject({ status: 'failed', httpStatus: null });
      expect(ctx.alerter.alerts).toHaveLength(1);
    });
  });

  describe('floatMonitor', () => {
    it('alerts when keeper SOL is below FLOAT_MIN_SOL and treasury USDC below the next payout', async () => {
      const { model } = await createTestModel(ctx);
      await addRequest(model._id, micro(20), new Date());
      await Models.updateOne(
        { _id: model._id },
        { $set: { 'token.carryOverMicroUsdc': 500_000n } },
      );
      // No token: 90% of 20 USDC + 0.5 carry-over.
      expect(await expectedPayoutMicro(ctx)).toBe(18_500_000n);

      const monitor = createFloatMonitor(ctx, { floatMinLamports: 500_000_000n });
      ctx.chain.setSol(ctx.keeper.publicKey, 400_000_000n);
      ctx.chain.setUsdc(ctx.treasury.publicKey, micro(10));
      const low = await monitor.tick();
      expect(low.alerts).toEqual([
        'keeper float below FLOAT_MIN_SOL',
        'treasury USDC below next expected payout',
      ]);
      expect(ctx.alerter.alerts[0]?.body).toMatchObject({ balanceSol: '0.4', minSol: '0.5' });
      expect(ctx.alerter.alerts[1]?.body).toMatchObject({
        balanceUsdc: '10.000000',
        expectedPayoutUsdc: '18.500000',
      });

      ctx.alerter.alerts.length = 0;
      ctx.chain.setSol(ctx.keeper.publicKey, 600_000_000n);
      ctx.chain.setUsdc(ctx.treasury.publicKey, micro(100));
      expect((await monitor.tick()).alerts).toEqual([]);
      expect(ctx.alerter.alerts).toHaveLength(0);
    });
  });

  describe('holdExpiry', () => {
    it('releases holds past expiresAt through expireHolds', async () => {
      const user = await Users.create({
        wallet: 'HoldWallet1111111111111111111111111111111111',
        role: 'consumer',
        depositRef: 'HOLDEXP1',
        balanceMicroUsdc: micro(5),
      });
      const { holdId } = await hold(user._id, micro(2), {
        requestId: 'hold-expiry-1',
        expiresInMs: 1_000,
      });
      const job = createHoldExpiryJob(ctx);
      ctx.clock.set(new Date(Date.now() - HOUR));
      expect(await job.tick()).toBe(0);
      ctx.clock.set(new Date(Date.now() + HOUR));
      expect(await job.tick()).toBe(1);
      expect((await Users.findById(user._id).lean())?.heldMicroUsdc).toBe(0n);
      expect((await Ledger.findById(holdId).lean())?.status).toBe('expired');
      expect(await job.tick()).toBe(0);
    });
  });

  describe('stats', () => {
    async function settlement(modelId: Types.ObjectId, hour: number, state: string, sol: bigint) {
      const periodStart = new Date(Date.UTC(2026, 0, 1, hour));
      await Settlements.create({
        modelId,
        periodStart,
        periodEnd: new Date(periodStart.getTime() + HOUR),
        state,
        liquidity: { phase: 'graduated', solAddedLamports: sol },
      });
    }

    it('writes rolling 24 h requests, successRate, revenue and lockedLiquidity per model', async () => {
      const now = new Date('2026-06-01T12:00:00Z');
      ctx.clock.set(now);
      const { model } = await createTestModel(ctx);
      const idle = await createTestModel(ctx);
      const ago = (h: number) => new Date(now.getTime() - h * HOUR);
      await addRequest(model._id, micro(1), ago(1));
      await addRequest(model._id, micro(2), ago(23));
      await addRequest(model._id, micro(9), ago(2), 'upstream_error');
      await addRequest(model._id, micro(50), ago(25));
      await settlement(model._id, 1, 'done', 300_000_000n);
      await settlement(model._id, 2, 'done', 200_000_000n);
      await settlement(model._id, 3, 'failed', 1_000_000_000n);

      expect(await createStatsJob(ctx).tick()).toBeGreaterThanOrEqual(2);
      const stats = (await Models.findById(model._id).lean())?.stats;
      expect(stats).toEqual({
        requests: 3,
        successRate: 2 / 3,
        revenueMicroUsdc: micro(3),
        lockedLiquidityLamports: 500_000_000n,
      });
      expect(lamportsToSol(stats?.lockedLiquidityLamports ?? 0n)).toBe('0.5');
      expect((await Models.findById(idle.model._id).lean())?.stats).toEqual({
        requests: 0,
        successRate: 0,
        revenueMicroUsdc: 0n,
        lockedLiquidityLamports: 0n,
      });
    });
  });
});
