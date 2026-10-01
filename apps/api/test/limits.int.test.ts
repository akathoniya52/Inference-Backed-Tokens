import { Models, Requests, Types, adjust } from '@ibt/db';
import { createMockUpstream, type MockUpstream } from '@ibt/mock-upstream';
import { MeResponseSchema, RATE_LIMIT_PER_MIN, usdcStringToMicro } from '@ibt/shared';
import { encrypt } from '@ibt/shared/node';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env.js';
import {
  bearer,
  createApiKey,
  errorOf,
  makeTestApp,
  newWallet,
  signIn,
  testEnvSource,
  type TestApp,
} from './helpers.js';

/** 0.1 USDC per prompt token, free output: each call costs a few tenths of a USDC. */
const IN_PRICE = 100_000_000_000n;

describe('gateway limits: per-key rate limit and daily cap', () => {
  let t: TestApp;
  let small: TestApp;
  let mock: MockUpstream;

  async function userIdOf(app: TestApp, jwt: string): Promise<string> {
    const me = await request(app.app).get('/api/me').set('Authorization', bearer(jwt));
    return MeResponseSchema.parse(me.body).id;
  }

  async function fundedKey(app: TestApp, dailyCapUsdc?: string) {
    const jwt = await signIn(app.app, newWallet().keypair);
    const userId = await userIdOf(app, jwt);
    await adjust(userId, 100_000_000n, 'test credit');
    const created = await createApiKey(
      app.app,
      jwt,
      dailyCapUsdc === undefined ? { name: 'k' } : { name: 'k', dailyCapUsdc },
    );
    return { ...created, userId };
  }

  function chat(app: TestApp, key: string) {
    return request(app.app)
      .post('/v1/chat/completions')
      .set('Authorization', bearer(key))
      .send({ model: 'limits-model', messages: [{ role: 'user', content: 'Hi there' }] });
  }

  beforeAll(async () => {
    mock = await createMockUpstream({ port: 0 });
    t = await makeTestApp();
    small = await makeTestApp({ env: { RATE_LIMIT_PER_MIN: '8', DAILY_CAP_USDC: '0.5' } });
    const jwt = await signIn(t.app, newWallet().keypair);
    await Models.create({
      providerId: new Types.ObjectId(await userIdOf(t, jwt)),
      slug: 'limits-model',
      name: 'limits-model',
      upstream: {
        baseUrl: `${mock.url}/v1`,
        modelName: 'upstream',
        apiKeyEnc: encrypt('mock-key', t.env.MASTER_KEY),
      },
      pricing: { inputPerMTokMicroUsdc: IN_PRICE, outputPerMTokMicroUsdc: 0n },
    });
    // `small` has its own MASTER_KEY; give it the same model under another slug.
    await Models.create({
      providerId: new Types.ObjectId(await userIdOf(t, jwt)),
      slug: 'limits-model-small',
      name: 'limits-model-small',
      upstream: {
        baseUrl: `${mock.url}/v1`,
        modelName: 'upstream',
        apiKeyEnc: encrypt('mock-key', small.env.MASTER_KEY),
      },
      pricing: { inputPerMTokMicroUsdc: IN_PRICE, outputPerMTokMicroUsdc: 0n },
    });
  });

  afterAll(async () => {
    await small.close();
    await t.close();
    await mock.close();
  });

  it(`the request after ${RATE_LIMIT_PER_MIN} in a minute gets 429 rate_limited, per key`, async () => {
    const limited = await fundedKey(t);
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i += 1) {
      const res = await request(t.app).get('/v1/models').set('Authorization', bearer(limited.key));
      expect(res.status).toBe(200);
    }
    const over = await chat(t, limited.key);
    expect(over.status).toBe(429);
    expect(errorOf(over)).toMatchObject({
      code: 'rate_limited',
      requestId: over.get('X-Request-Id'),
    });
    expect(await Requests.countDocuments({ apiKeyId: new Types.ObjectId(limited.id) })).toBe(0);

    const other = await fundedKey(t);
    expect((await chat(t, other.key)).status).toBe(200);
  });

  it('RATE_LIMIT_PER_MIN overrides the default', async () => {
    const k = await fundedKey(small);
    for (let i = 0; i < 8; i += 1) {
      const res = await request(small.app).get('/v1/models').set('Authorization', bearer(k.key));
      expect(res.status).toBe(200);
    }
    const res = await request(small.app).get('/v1/models').set('Authorization', bearer(k.key));
    expect(res.status).toBe(429);
  });

  it('a 1 USDC daily cap is hit after N requests with 429 daily_cap_exceeded', async () => {
    const k = await fundedKey(t, '1');
    const costs: bigint[] = [];
    let capped: request.Response | undefined;
    for (let i = 0; i < 20 && capped === undefined; i += 1) {
      const res = await chat(t, k.key);
      if (res.status === 200) costs.push(usdcStringToMicro(res.get('X-Cost-Usdc') ?? ''));
      else capped = res;
    }

    expect(capped?.status).toBe(429);
    expect(capped && errorOf(capped)).toMatchObject({
      code: 'daily_cap_exceeded',
      dailyCapUsdc: '1.000000',
    });
    expect(costs.length).toBeGreaterThanOrEqual(2);
    const total = costs.reduce((sum, cost) => sum + cost, 0n);
    const beforeLast = total - (costs.at(-1) ?? 0n);
    expect(total).toBeGreaterThanOrEqual(1_000_000n);
    expect(beforeLast).toBeLessThan(1_000_000n);
    // Rejected before the hold, so the capped call left no request doc.
    expect(await Requests.countDocuments({ apiKeyId: new Types.ObjectId(k.id) })).toBe(
      costs.length,
    );
  });

  it('only counts spend from the current UTC day, and only for that key', async () => {
    const k = await fundedKey(t, '1');
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await Requests.collection.insertOne({
      userId: new Types.ObjectId(k.userId),
      apiKeyId: new Types.ObjectId(k.id),
      modelId: new Types.ObjectId(),
      requestId: `old-${k.id}`,
      status: 'success',
      costMicroUsdc: 5_000_000n,
      settlementId: null,
      createdAt: yesterday,
    });
    expect((await chat(t, k.key)).status).toBe(200);
  });

  it('DAILY_CAP_USDC sets the default cap of new keys', async () => {
    const k = await fundedKey(small);
    expect(k.dailyCapUsdc).toBe('0.500000');
    const res = await request(small.app)
      .post('/v1/chat/completions')
      .set('Authorization', bearer(k.key))
      .send({ model: 'limits-model-small', messages: [{ role: 'user', content: 'Hi there' }] });
    expect(res.status).toBe(200);
    let last = res;
    for (let i = 0; i < 10 && last.status === 200; i += 1) {
      last = await request(small.app)
        .post('/v1/chat/completions')
        .set('Authorization', bearer(k.key))
        .send({ model: 'limits-model-small', messages: [{ role: 'user', content: 'Hi there' }] });
    }
    expect(last.status).toBe(429);
    expect(errorOf(last)).toMatchObject({ code: 'daily_cap_exceeded', dailyCapUsdc: '0.500000' });
  });

  it('the env schema validates the overrides and still refuses signing keys', () => {
    const base = testEnvSource('mongodb://localhost:27017/x');
    expect(loadEnv({ ...base, RATE_LIMIT_PER_MIN: '120' }).RATE_LIMIT_PER_MIN).toBe(120);
    expect(() => loadEnv({ ...base, RATE_LIMIT_PER_MIN: '0' })).toThrow(/RATE_LIMIT_PER_MIN/);
    expect(() => loadEnv({ ...base, DAILY_CAP_USDC: '-1' })).toThrow(/DAILY_CAP_USDC/);
    expect(() => loadEnv({ ...base, KEEPER_SECRET_KEY: 'x' })).toThrow(/KEEPER_SECRET_KEY/);
    expect(() => loadEnv({ ...base, TREASURY_SECRET_KEY: 'x' })).toThrow(/TREASURY_SECRET_KEY/);
  });
});
