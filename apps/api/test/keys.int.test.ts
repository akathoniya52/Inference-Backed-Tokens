import { ApiKeys } from '@ibt/db';
import {
  API_KEY_PREFIX,
  CreateApiKeyResponseSchema,
  GatewayModelListSchema,
  ListApiKeysResponseSchema,
  RevokeApiKeyResponseSchema,
} from '@ibt/shared';
import { sha256Hex } from '@ibt/shared/node';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bearer,
  createApiKey,
  errorOf,
  makeTestApp,
  newWallet,
  signIn,
  type TestApp,
} from './helpers.js';

describe('API keys', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeTestApp({ env: { DAILY_CAP_USDC: '12.5' } });
  });

  afterAll(async () => {
    await t.close();
  });

  it('POST returns the full key exactly once and stores only its hash', async () => {
    const jwt = await signIn(t.app, newWallet().keypair);
    const res = await request(t.app)
      .post('/api/keys')
      .set('Authorization', bearer(jwt))
      .send({ name: 'laptop' });
    expect(res.status).toBe(201);
    const created = CreateApiKeyResponseSchema.parse(res.body);
    expect(created.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(created.prefix).toBe(created.key.slice(0, 12));
    expect(created).toMatchObject({ name: 'laptop', status: 'active', dailyCapUsdc: '12.500000' });
    expect(res.text.split(created.key)).toHaveLength(2);

    const stored = await ApiKeys.findById(created.id).lean();
    expect(stored?.keyHash).toBe(sha256Hex(created.key));
    expect(
      JSON.stringify(stored, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toContain(created.key);

    const list = await request(t.app).get('/api/keys').set('Authorization', bearer(jwt));
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(created.key);
    const parsed = ListApiKeysResponseSchema.parse(list.body);
    expect(parsed.items.map((k) => k.id)).toEqual([created.id]);
    expect(list.text).not.toContain('"key"');
  });

  it('accepts a per-key daily cap', async () => {
    const jwt = await signIn(t.app, newWallet().keypair);
    const created = await createApiKey(t.app, jwt, { name: 'capped', dailyCapUsdc: '3.25' });
    expect(created.dailyCapUsdc).toBe('3.250000');
    expect((await ApiKeys.findById(created.id).lean())?.dailyCapMicroUsdc).toBe(3_250_000n);
  });

  it('requires a JWT and validates the body', async () => {
    const anon = await request(t.app).post('/api/keys').send({ name: 'x' });
    expect(anon.status).toBe(401);
    const jwt = await signIn(t.app, newWallet().keypair);
    const bad = await request(t.app).post('/api/keys').set('Authorization', bearer(jwt)).send({});
    expect(bad.status).toBe(400);
    expect(errorOf(bad).code).toBe('invalid_request');
  });

  it('paginates: 3 keys with limit=2 → 2 items plus a cursor that returns the third', async () => {
    const jwt = await signIn(t.app, newWallet().keypair);
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) ids.push((await createApiKey(t.app, jwt, { name })).id);

    const page1 = await request(t.app).get('/api/keys?limit=2').set('Authorization', bearer(jwt));
    const first = ListApiKeysResponseSchema.parse(page1.body);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));

    const page2 = await request(t.app)
      .get('/api/keys')
      .query({ limit: 2, cursor: first.nextCursor })
      .set('Authorization', bearer(jwt));
    const second = ListApiKeysResponseSchema.parse(page2.body);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((k) => k.id).sort()).toEqual([...ids].sort());

    const tooMany = await request(t.app)
      .get('/api/keys?limit=101')
      .set('Authorization', bearer(jwt));
    expect(tooMany.status).toBe(400);
    const badCursor = await request(t.app)
      .get('/api/keys?cursor=nope')
      .set('Authorization', bearer(jwt));
    expect(badCursor.status).toBe(400);
  });

  it('only lists and revokes the caller’s own keys', async () => {
    const alice = await signIn(t.app, newWallet().keypair);
    const bob = await signIn(t.app, newWallet().keypair);
    const key = await createApiKey(t.app, alice, { name: 'alice' });

    const bobList = ListApiKeysResponseSchema.parse(
      (await request(t.app).get('/api/keys').set('Authorization', bearer(bob))).body,
    );
    expect(bobList.items).toEqual([]);

    const steal = await request(t.app)
      .delete(`/api/keys/${key.id}`)
      .set('Authorization', bearer(bob));
    expect(steal.status).toBe(404);
    expect((await ApiKeys.findById(key.id).lean())?.status).toBe('active');
  });

  it('a valid key reaches /v1/models; a revoked key gets 401 invalid_api_key', async () => {
    const jwt = await signIn(t.app, newWallet().keypair);
    const key = await createApiKey(t.app, jwt, { name: 'gateway' });

    const ok = await request(t.app).get('/v1/models').set('Authorization', bearer(key.key));
    expect(ok.status).toBe(200);
    expect(GatewayModelListSchema.parse(ok.body).object).toBe('list');
    expect((await ApiKeys.findById(key.id).lean())?.lastUsedAt).toBeInstanceOf(Date);

    const revoked = await request(t.app)
      .delete(`/api/keys/${key.id}`)
      .set('Authorization', bearer(jwt));
    expect(revoked.status).toBe(200);
    expect(RevokeApiKeyResponseSchema.parse(revoked.body).status).toBe('revoked');
    expect(revoked.text).not.toContain(key.key);

    const denied = await request(t.app).get('/v1/models').set('Authorization', bearer(key.key));
    expect(denied.status).toBe(401);
    expect(errorOf(denied).code).toBe('invalid_api_key');
  });

  it('missing or unknown keys get 401 invalid_api_key; a JWT is not an API key', async () => {
    const missing = await request(t.app).get('/v1/models');
    expect(missing.status).toBe(401);
    expect(errorOf(missing).code).toBe('invalid_api_key');
    const unknown = await request(t.app)
      .get('/v1/models')
      .set('Authorization', bearer(`${API_KEY_PREFIX}doesnotexist`));
    expect(errorOf(unknown).code).toBe('invalid_api_key');
    const jwt = await signIn(t.app, newWallet().keypair);
    const asKey = await request(t.app).get('/v1/models').set('Authorization', bearer(jwt));
    expect(errorOf(asKey).code).toBe('invalid_api_key');
  });

  it('throttles lastUsedAt updates', async () => {
    const jwt = await signIn(t.app, newWallet().keypair);
    const key = await createApiKey(t.app, jwt, { name: 'throttle' });
    await request(t.app).get('/v1/models').set('Authorization', bearer(key.key));
    const firstUse = (await ApiKeys.findById(key.id).lean())?.lastUsedAt;
    t.clock.advance(1000);
    await request(t.app).get('/v1/models').set('Authorization', bearer(key.key));
    expect((await ApiKeys.findById(key.id).lean())?.lastUsedAt).toEqual(firstUse);
    t.clock.advance(120_000);
    await request(t.app).get('/v1/models').set('Authorization', bearer(key.key));
    expect((await ApiKeys.findById(key.id).lean())?.lastUsedAt).not.toEqual(firstUse);
  });
});
