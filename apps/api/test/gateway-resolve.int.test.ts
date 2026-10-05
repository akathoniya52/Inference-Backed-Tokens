import { Models, Types } from '@ibt/db';
import { GatewayModelListSchema, MAX_TOKENS_CAP, MeResponseSchema } from '@ibt/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveModel, validateChatRequest } from '../src/modules/gateway/router.js';
import {
  bearer,
  createApiKey,
  errorOf,
  makeTestApp,
  newWallet,
  signIn,
  type TestApp,
} from './helpers.js';

describe('gateway: /v1/models, resolve and validation', () => {
  let t: TestApp;
  let key: string;

  async function seedModel(slug: string, status: 'active' | 'paused' | 'delisted') {
    const provider = await signIn(t.app, newWallet().keypair);
    const me = await request(t.app).get('/api/me').set('Authorization', bearer(provider));
    const { id } = MeResponseSchema.parse(me.body);
    return Models.create({
      providerId: new Types.ObjectId(id),
      slug,
      name: slug,
      status,
      upstream: { baseUrl: 'http://127.0.0.1:1/v1', modelName: 'up', apiKeyEnc: 'secret-enc' },
      pricing: { inputPerMTokMicroUsdc: 100_000n, outputPerMTokMicroUsdc: 400_000n },
    });
  }

  function chat(body: object) {
    return request(t.app).post('/v1/chat/completions').set('Authorization', bearer(key)).send(body);
  }

  const hello = [{ role: 'user', content: 'Hello' }];

  beforeAll(async () => {
    t = await makeTestApp();
    await seedModel('gw-active', 'active');
    await seedModel('gw-paused', 'paused');
    await seedModel('gw-delisted', 'delisted');
    const jwt = await signIn(t.app, newWallet().keypair);
    key = (await createApiKey(t.app, jwt)).key;
  });

  afterAll(async () => {
    await t.close();
  });

  it('GET /v1/models lists active models in OpenAI format with prices', async () => {
    const res = await request(t.app).get('/v1/models').set('Authorization', bearer(key));
    expect(res.status).toBe(200);
    const list = GatewayModelListSchema.parse(res.body);
    expect(list.object).toBe('list');
    expect(list.data.map((m) => m.id)).toEqual(['gw-active']);
    expect(list.data[0]).toMatchObject({
      object: 'model',
      pricing: { input_per_mtok_usdc: '0.100000', output_per_mtok_usdc: '0.400000' },
    });
    expect(res.text).not.toContain('secret-enc');
    expect(res.text).not.toContain('apiKeyEnc');
  });

  it('resolveModel: unknown and delisted → 404, paused → 503, active resolves', async () => {
    await expect(resolveModel('nope')).rejects.toMatchObject({ code: 'model_not_found' });
    await expect(resolveModel('gw-delisted')).rejects.toMatchObject({ code: 'model_not_found' });
    await expect(resolveModel('gw-paused')).rejects.toMatchObject({
      code: 'model_paused',
      httpStatus: 503,
    });
    expect((await resolveModel('gw-active')).slug).toBe('gw-active');
  });

  it('POST /v1/chat/completions maps resolve failures to 404 / 503', async () => {
    const missing = await chat({ model: 'nope', messages: hello });
    expect(missing.status).toBe(404);
    expect(errorOf(missing).code).toBe('model_not_found');

    const paused = await chat({ model: 'gw-paused', messages: hello });
    expect(paused.status).toBe(503);
    expect(errorOf(paused).code).toBe('model_paused');
  });

  it('invalid bodies get 400 invalid_request before the model is resolved', async () => {
    const cases: object[] = [
      {},
      { model: 'gw-active' },
      { model: 'gw-active', messages: [] },
      { model: 'gw-active', messages: [{ role: 'robot', content: 'x' }] },
      { model: 'gw-active', messages: hello, temperature: 3 },
      { model: 'gw-active', messages: hello, n: 2 },
      { model: 'gw-active', messages: hello, max_tokens: 0 },
      { model: 'gw-active', messages: hello, max_tokens: MAX_TOKENS_CAP + 1 },
      { model: 'nope', messages: hello, max_completion_tokens: MAX_TOKENS_CAP + 1 },
    ];
    for (const body of cases) {
      const res = await chat(body);
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('invalid_request');
    }
  });

  it('a valid request passes validation and resolve and reaches the hold', async () => {
    const res = await chat({ model: 'gw-active', messages: hello, max_tokens: MAX_TOKENS_CAP });
    expect(res.status).toBe(402);
    expect(errorOf(res).code).toBe('insufficient_credits');
  });

  it('validateChatRequest applies the max_tokens default and keeps unknown fields', () => {
    expect(validateChatRequest({ model: 'm', messages: hello }).maxTokens).toBe(1024);
    expect(validateChatRequest({ model: 'm', messages: hello, max_tokens: 64 }).maxTokens).toBe(64);
    const both = validateChatRequest({
      model: 'm',
      messages: hello,
      max_tokens: 32,
      max_completion_tokens: 32,
      tools: [{ type: 'function' }],
      response_format: { type: 'json_object' },
    });
    expect(both.maxTokens).toBe(32);
    expect(both.body).toHaveProperty('response_format');
    // A3: two different limits would let one reach the upstream unheld.
    expect(() =>
      validateChatRequest({
        model: 'm',
        messages: hello,
        max_tokens: 64,
        max_completion_tokens: 32,
      }),
    ).toThrow(/max_tokens and max_completion_tokens must match/);
  });

  it('requires an API key', async () => {
    const res = await request(t.app).post('/v1/chat/completions').send({ model: 'x' });
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('invalid_api_key');
  });
});
