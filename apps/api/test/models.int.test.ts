import { Models, Users } from '@ibt/db';
import {
  ListModelsResponseSchema,
  ModelSchema,
  OwnerModelSchema,
  type CreateModelRequest,
} from '@ibt/shared';
import { decrypt } from '@ibt/shared/node';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, errorOf, makeTestApp, newWallet, signIn, type TestApp } from './helpers.js';

const PLAINTEXT_KEYS: string[] = [];
const bodies: string[] = [];

/** Every response body is kept so the final test can grep them all for secrets. */
function record(res: Response): Response {
  bodies.push(res.text);
  return res;
}

let slugCounter = 0;
function modelBody(overrides: Partial<CreateModelRequest> = {}): CreateModelRequest {
  slugCounter += 1;
  const apiKey = `sk-upstream-secret-${slugCounter}-${Math.random().toString(36).slice(2)}`;
  PLAINTEXT_KEYS.push(apiKey);
  return {
    slug: `test-model-${slugCounter}`,
    name: `Test Model ${slugCounter}`,
    description: 'A model for tests',
    upstream: {
      baseUrl: 'http://127.0.0.1:4010/v1',
      modelName: 'mock-8b',
      apiKey,
      supportsStreamUsage: false,
    },
    pricing: { inputPerMTokUsdc: '0.10', outputPerMTokUsdc: '0.4' },
    ...overrides,
  };
}

describe('models', () => {
  let t: TestApp;
  let owner: string;
  let ownerWallet: string;
  let stranger: string;

  beforeAll(async () => {
    t = await makeTestApp();
    const w = newWallet();
    ownerWallet = w.wallet;
    owner = await signIn(t.app, w.keypair);
    stranger = await signIn(t.app, newWallet().keypair);
  });

  afterAll(async () => {
    await t.close();
  });

  async function create(jwt: string, body = modelBody()) {
    return record(
      await request(t.app).post('/api/models').set('Authorization', bearer(jwt)).send(body),
    );
  }

  it('POST registers a model, encrypts the upstream key and makes the user a provider', async () => {
    const body = modelBody();
    const res = await create(owner, body);
    expect(res.status).toBe(201);
    const model = OwnerModelSchema.parse(res.body);
    expect(model).toMatchObject({
      slug: body.slug,
      providerWallet: ownerWallet,
      status: 'active',
      pricing: { inputPerMTokUsdc: '0.100000', outputPerMTokUsdc: '0.400000' },
      splits: { providerBps: 7000, liquidityBps: 2000, platformBps: 1000 },
      upstream: {
        baseUrl: body.upstream.baseUrl,
        modelName: 'mock-8b',
        supportsStreamUsage: false,
      },
      token: { status: 'none', mint: null },
      health: { consecutiveFailures: 0 },
    });

    const stored = await Models.findById(model.id).lean();
    expect(stored?.upstream.apiKeyEnc).not.toContain(body.upstream.apiKey);
    expect(decrypt(stored?.upstream.apiKeyEnc ?? '', t.env.MASTER_KEY)).toBe(body.upstream.apiKey);
    expect(stored?.pricing.inputPerMTokMicroUsdc).toBe(100_000n);
    expect((await Users.findOne({ wallet: ownerWallet }).lean())?.role).toBe('provider');
  });

  it('rejects anonymous, invalid and duplicate registrations', async () => {
    const anon = record(await request(t.app).post('/api/models').send(modelBody()));
    expect(anon.status).toBe(401);

    const invalid = await create(owner, { ...modelBody(), slug: 'Bad Slug!' });
    expect(invalid.status).toBe(400);
    expect(errorOf(invalid).code).toBe('invalid_request');

    const body = modelBody();
    expect((await create(owner, body)).status).toBe(201);
    const dup = await create(stranger, { ...modelBody(), slug: body.slug });
    expect(dup.status).toBe(400);
    expect(errorOf(dup).message).toContain('slug');
  });

  it('GET /api/models/:slug is public and includes stats and token', async () => {
    const body = modelBody();
    await create(owner, body);
    const res = record(await request(t.app).get(`/api/models/${body.slug}`));
    expect(res.status).toBe(200);
    const model = ModelSchema.parse(res.body);
    expect(model.stats).toEqual({
      requests24h: 0,
      successRate: 0,
      revenueUsdc24h: '0.000000',
      lockedLiquiditySol: '0',
    });
    expect(model.token.status).toBe('none');
    expect(res.text).not.toContain('upstream');

    const missing = record(await request(t.app).get('/api/models/no-such-model'));
    expect(missing.status).toBe(404);
    expect(errorOf(missing).code).toBe('model_not_found');
  });

  it('GET /api/models paginates with an opaque cursor', async () => {
    for (let i = 0; i < 3; i += 1) await create(owner);
    const total = await Models.countDocuments();
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = record(
        await request(t.app)
          .get('/api/models')
          .query(cursor === null ? { limit: 2 } : { limit: 2, cursor }),
      );
      expect(res.status).toBe(200);
      const page = ListModelsResponseSchema.parse(res.body);
      expect(page.items.length).toBeLessThanOrEqual(2);
      for (const item of page.items) seen.add(item.id);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 50);
    expect(pages).toBeGreaterThan(1);
    expect(seen.size).toBe(total);

    const tooBig = record(await request(t.app).get('/api/models?limit=101'));
    expect(tooBig.status).toBe(400);
  });

  it('PATCH is owner-only; pause and resume reset consecutiveFailures', async () => {
    const created = OwnerModelSchema.parse((await create(owner)).body);
    await Models.updateOne({ _id: created.id }, { $set: { 'health.consecutiveFailures': 2 } });

    const foreign = record(
      await request(t.app)
        .patch(`/api/models/${created.id}`)
        .set('Authorization', bearer(stranger))
        .send({ status: 'paused' }),
    );
    expect(foreign.status).toBe(403);
    expect(errorOf(foreign).code).toBe('forbidden');

    const paused = record(
      await request(t.app)
        .patch(`/api/models/${created.id}`)
        .set('Authorization', bearer(owner))
        .send({ status: 'paused' }),
    );
    expect(paused.status).toBe(200);
    expect(OwnerModelSchema.parse(paused.body).status).toBe('paused');

    const resumed = record(
      await request(t.app)
        .patch(`/api/models/${created.id}`)
        .set('Authorization', bearer(owner))
        .send({ status: 'active' }),
    );
    const model = OwnerModelSchema.parse(resumed.body);
    expect(model.status).toBe('active');
    expect(model.health.consecutiveFailures).toBe(0);
  });

  it('PATCH updates fields and replaces the upstream key without reading it back', async () => {
    const created = OwnerModelSchema.parse((await create(owner)).body);
    const newKey = `sk-replacement-${Math.random().toString(36).slice(2)}`;
    PLAINTEXT_KEYS.push(newKey);
    const res = record(
      await request(t.app)
        .patch(`/api/models/${created.id}`)
        .set('Authorization', bearer(owner))
        .send({
          name: 'Renamed',
          pricing: { outputPerMTokUsdc: '1.5' },
          upstream: { apiKey: newKey, supportsStreamUsage: true },
        }),
    );
    expect(res.status).toBe(200);
    const model = OwnerModelSchema.parse(res.body);
    expect(model.name).toBe('Renamed');
    expect(model.pricing).toEqual({ inputPerMTokUsdc: '0.100000', outputPerMTokUsdc: '1.500000' });
    expect(model.upstream).toMatchObject({ modelName: 'mock-8b', supportsStreamUsage: true });
    const stored = await Models.findById(created.id).lean();
    expect(decrypt(stored?.upstream.apiKeyEnc ?? '', t.env.MASTER_KEY)).toBe(newKey);

    const empty = record(
      await request(t.app)
        .patch(`/api/models/${created.id}`)
        .set('Authorization', bearer(owner))
        .send({}),
    );
    expect(empty.status).toBe(400);
    const missing = record(
      await request(t.app)
        .patch('/api/models/0123456789abcdef01234567')
        .set('Authorization', bearer(owner))
        .send({ name: 'x' }),
    );
    expect(missing.status).toBe(404);
  });

  it('PATCH to a new upstream.baseUrl requires re-supplying upstream.apiKey', async () => {
    const created = OwnerModelSchema.parse((await create(owner)).body);
    const patch = (upstream: Record<string, string>) =>
      request(t.app)
        .patch(`/api/models/${created.id}`)
        .set('Authorization', bearer(owner))
        .send({ upstream });

    const moved = record(await patch({ baseUrl: 'https://attacker.example/v1' }));
    expect(moved.status).toBe(400);
    expect(errorOf(moved).code).toBe('invalid_request');
    expect((await Models.findById(created.id).lean())?.upstream.baseUrl).toBe(
      created.upstream.baseUrl,
    );

    const unchanged = record(await patch({ baseUrl: created.upstream.baseUrl, modelName: 'm2' }));
    expect(unchanged.status).toBe(200);

    const newKey = `sk-moved-${Math.random().toString(36).slice(2)}`;
    PLAINTEXT_KEYS.push(newKey);
    const withKey = record(await patch({ baseUrl: 'https://api.example.com/v1', apiKey: newKey }));
    expect(withKey.status).toBe(200);
    expect(OwnerModelSchema.parse(withKey.body).upstream.baseUrl).toBe(
      'https://api.example.com/v1',
    );
    const stored = await Models.findById(created.id).lean();
    expect(decrypt(stored?.upstream.apiKeyEnc ?? '', t.env.MASTER_KEY)).toBe(newKey);
  });

  it('no response body ever contains apiKeyEnc or a plaintext upstream key', () => {
    expect(bodies.length).toBeGreaterThan(10);
    for (const text of bodies) {
      expect(text).not.toContain('apiKeyEnc');
      for (const key of PLAINTEXT_KEYS) expect(text).not.toContain(key);
    }
  });
});
