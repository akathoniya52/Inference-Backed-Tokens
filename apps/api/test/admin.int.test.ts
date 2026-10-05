import { Models, Requests, Settlements, Types } from '@ibt/db';
import { createMockUpstream, type MockUpstream } from '@ibt/mock-upstream';
import {
  FloatResponseSchema,
  HealthChecksRunResponseSchema,
  ModelPauseResponseSchema,
  SettlementRetryResponseSchema,
} from '@ibt/shared';
import { encrypt } from '@ibt/shared/node';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toPublicKey } from '../src/lib/publicKey.js';
import { bearer, errorOf, makeTestApp, newWallet, type TestApp } from './helpers.js';

describe('admin module', () => {
  let t: TestApp;
  let fenced: TestApp;
  let mock: MockUpstream;
  const keeperWallet = newWallet().wallet;
  const treasuryWallet = newWallet().wallet;

  function admin(method: 'get' | 'post', path: string, app: TestApp = t) {
    const agent = request(app.app);
    const url = `/api/admin${path}`;
    const req = method === 'get' ? agent.get(url) : agent.post(url);
    return req.set('Authorization', bearer(app.env.ADMIN_TOKEN));
  }

  async function seedModel(slug: string, fields: Record<string, unknown> = {}) {
    const doc = await Models.create({
      providerId: new Types.ObjectId(),
      slug,
      name: slug,
      upstream: {
        baseUrl: `${mock.url}/v1`,
        modelName: 'upstream',
        apiKeyEnc: encrypt('mock-key', t.env.MASTER_KEY),
      },
      pricing: { inputPerMTokMicroUsdc: 1n, outputPerMTokMicroUsdc: 1n },
      ...fields,
    });
    return doc._id;
  }

  async function seedSettlement(state: string, lastCompletedState: string | null) {
    const doc = await Settlements.create({
      modelId: new Types.ObjectId(),
      periodStart: new Date(Date.UTC(2026, 9, 1, Math.floor(Math.random() * 24))),
      periodEnd: new Date(),
      state,
      lastCompletedState,
      attempts: 3,
      error: state === 'failed' ? 'rpc down' : null,
    });
    return doc._id.toHexString();
  }

  beforeAll(async () => {
    mock = await createMockUpstream({ port: 0 });
    t = await makeTestApp({
      env: { KEEPER_WALLET: keeperWallet, TREASURY_WALLET: treasuryWallet, FLOAT_MIN_SOL: '0.5' },
    });
    fenced = await makeTestApp({ env: { ADMIN_IP_ALLOWLIST: '10.9.9.9, 10.9.9.10' } });
  });

  afterAll(async () => {
    await fenced.close();
    await t.close();
    await mock.close();
  });

  describe('adminAuth', () => {
    it('missing or wrong token → 401', async () => {
      const missing = await request(t.app).get('/api/admin/float');
      expect(missing.status).toBe(401);
      expect(errorOf(missing).code).toBe('unauthorized');

      const wrong = await request(t.app)
        .get('/api/admin/float')
        .set('Authorization', bearer(`${t.env.ADMIN_TOKEN}x`));
      expect(wrong.status).toBe(401);

      const jwtLike = await request(t.app)
        .get('/api/admin/float')
        .set('Authorization', bearer('a'));
      expect(jwtLike.status).toBe(401);
    });

    it('a client address outside ADMIN_IP_ALLOWLIST → 403, even with the token', async () => {
      const denied = await admin('get', '/float', fenced).set('X-Forwarded-For', '10.1.1.1');
      expect(denied.status).toBe(403);
      expect(errorOf(denied).code).toBe('forbidden');

      const allowed = await admin('get', '/float', fenced).set('X-Forwarded-For', '10.9.9.10');
      expect(allowed.status).toBe(200);

      const wrongToken = await request(fenced.app)
        .get('/api/admin/float')
        .set('X-Forwarded-For', '10.9.9.9')
        .set('Authorization', bearer('nope'));
      expect(wrongToken.status).toBe(401);
    });

    it('rate limits to 30/min per client address, counting failed tokens', async () => {
      const ip = '203.0.113.77';
      for (let i = 0; i < 30; i += 1) {
        const res = await request(t.app)
          .get('/api/admin/float')
          .set('X-Forwarded-For', ip)
          .set('Authorization', bearer(`guess-${i}`));
        expect(res.status).toBe(401);
      }
      const limited = await admin('get', '/float').set('X-Forwarded-For', ip);
      expect(limited.status).toBe(429);
      expect(errorOf(limited).code).toBe('rate_limited');

      const other = await admin('get', '/float').set('X-Forwarded-For', '203.0.113.78');
      expect(other.status).toBe(200);
    });
  });

  describe('POST /settlements/:id/retry', () => {
    it('failed → lastCompletedState with attempts reset and error cleared', async () => {
      const id = await seedSettlement('failed', 'paid_provider');
      const res = await admin('post', `/settlements/${id}/retry`);
      expect(res.status).toBe(200);
      expect(SettlementRetryResponseSchema.parse(res.body)).toEqual({ id, state: 'paid_provider' });
      const row = await Settlements.findById(id).lean();
      expect(row).toMatchObject({ state: 'paid_provider', attempts: 0, error: null });
    });

    it('failed with nothing completed restarts at computing', async () => {
      const id = await seedSettlement('failed', null);
      const res = await admin('post', `/settlements/${id}/retry`);
      expect(res.body).toEqual({ id, state: 'computing' });
    });

    it('any other state → 409 settlement_not_retryable; unknown → 404', async () => {
      const id = await seedSettlement('done', 'locked');
      const res = await admin('post', `/settlements/${id}/retry`);
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('settlement_not_retryable');
      expect((await Settlements.findById(id).lean())?.state).toBe('done');

      const unknown = await admin(
        'post',
        `/settlements/${new Types.ObjectId().toHexString()}/retry`,
      );
      expect(unknown.status).toBe(404);
    });
  });

  describe('POST /models/:id/pause', () => {
    it('pauses an active model and is idempotent', async () => {
      const id = (await seedModel('admin-pause')).toHexString();
      const res = await admin('post', `/models/${id}/pause`);
      expect(res.status).toBe(200);
      expect(ModelPauseResponseSchema.parse(res.body)).toEqual({ id, status: 'paused' });
      expect((await Models.findById(id).lean())?.status).toBe('paused');
      expect((await admin('post', `/models/${id}/pause`)).status).toBe(200);
    });

    it('delisted → 400, unknown → 404', async () => {
      const id = (await seedModel('admin-delisted', { status: 'delisted' })).toHexString();
      expect((await admin('post', `/models/${id}/pause`)).status).toBe(400);
      const unknown = await admin('post', `/models/${new Types.ObjectId().toHexString()}/pause`);
      expect(errorOf(unknown).code).toBe('model_not_found');
    });
  });

  describe('GET /float', () => {
    it('compares the keeper float and the treasury with the next expected payout', async () => {
      const withToken = await seedModel('admin-float-token', {
        token: { status: 'curve', mint: newWallet().wallet },
      });
      const noToken = await seedModel('admin-float-none');
      const base = { userId: new Types.ObjectId(), apiKeyId: new Types.ObjectId() };
      await Requests.create([
        {
          ...base,
          modelId: withToken,
          requestId: 'f1',
          status: 'success',
          costMicroUsdc: 10_000_000n,
        },
        {
          ...base,
          modelId: noToken,
          requestId: 'f2',
          status: 'success',
          costMicroUsdc: 10_000_000n,
        },
        {
          ...base,
          modelId: noToken,
          requestId: 'f3',
          status: 'success',
          costMicroUsdc: 50_000_000n,
          settlementId: new Types.ObjectId(),
        },
        { ...base, modelId: noToken, requestId: 'f4', status: 'upstream_error', costMicroUsdc: 0n },
        {
          ...base,
          modelId: noToken,
          requestId: 'f5',
          status: 'client_abort',
          costMicroUsdc: 10_000_000n,
        },
      ]);
      t.chain.setSol(toPublicKey(keeperWallet), 300_000_000n);
      t.chain.setUsdc(toPublicKey(treasuryWallet), 15_000_000n);

      const res = await admin('get', '/float');
      expect(res.status).toBe(200);
      expect(FloatResponseSchema.parse(res.body)).toEqual({
        keeper: { wallet: keeperWallet, sol: '0.3', minSol: '0.5', belowMin: true },
        treasury: {
          wallet: treasuryWallet,
          usdc: '15.000000',
          // 70% of 10 (token launched) + 90% of 20 (no token yet, G17), the
          // captured client_abort included.
          nextExpectedPayoutUsdc: '25.000000',
          belowNextPayout: true,
        },
      });

      t.chain.setSol(toPublicKey(keeperWallet), 2_000_000_000n);
      t.chain.setUsdc(toPublicKey(treasuryWallet), 25_000_000n);
      const healthy = FloatResponseSchema.parse((await admin('get', '/float')).body);
      expect(healthy.keeper.belowMin).toBe(false);
      expect(healthy.treasury.belowNextPayout).toBe(false);
    });
  });

  describe('POST /health-checks/run', () => {
    it('checks every active model and summarises the results', async () => {
      await Models.updateMany({}, { $set: { status: 'delisted' } });
      await seedModel('admin-hc-ok');
      await seedModel('admin-hc-bad', {
        upstream: {
          baseUrl: `${mock.url}/v1`,
          modelName: 'upstream:error500',
          apiKeyEnc: encrypt('mock-key', t.env.MASTER_KEY),
        },
      });
      await seedModel('admin-hc-paused', { status: 'paused' });
      const before = mock.calls.length;

      const res = await admin('post', '/health-checks/run');
      expect(res.status).toBe(200);
      expect(HealthChecksRunResponseSchema.parse(res.body)).toEqual({
        checked: 2,
        ok: 1,
        failed: 1,
        paused: 0,
      });
      expect(mock.calls.length - before).toBe(2);
      const ok = await Models.findOne({ slug: 'admin-hc-ok' }).lean();
      expect(ok?.health.lastOkAt).toBeInstanceOf(Date);
    });
  });
});
