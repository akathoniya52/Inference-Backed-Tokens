import { randomBytes } from 'node:crypto';

import { OwnerModelSchema, TokenMetadataSchema } from '@ibt/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { base58Encode } from '../src/lib/base58.js';
import { bearer, errorOf, makeTestApp, newWallet, signIn, type TestApp } from './helpers.js';

describe('GET /metadata/:mint.json', () => {
  let t: TestApp;
  let owner: string;

  async function createModel(slug: string, imageUrl?: string): Promise<string> {
    const res = await request(t.app)
      .post('/api/models')
      .set('Authorization', bearer(owner))
      .send({
        slug,
        name: `Model ${slug}`,
        description: 'Fast llama',
        ...(imageUrl ? { imageUrl } : {}),
        upstream: { baseUrl: 'http://127.0.0.1:1/v1', modelName: 'm', apiKey: 'sk-meta-secret' },
        pricing: { inputPerMTokUsdc: '0.1', outputPerMTokUsdc: '0.4' },
      });
    return OwnerModelSchema.parse(res.body).id;
  }

  async function prepare(modelId: string, symbol?: string): Promise<string> {
    const mint = base58Encode(randomBytes(32));
    const res = await request(t.app)
      .post('/api/tokens/launch/prepare')
      .set('Authorization', bearer(owner))
      .send({ modelId, mint, ...(symbol ? { symbol } : {}) });
    if (res.status !== 200) throw new Error(`prepare failed: ${res.status}`);
    return mint;
  }

  beforeAll(async () => {
    t = await makeTestApp();
    owner = await signIn(t.app, newWallet().keypair);
  });

  afterAll(async () => {
    await t.close();
  });

  it('a pending mint returns 200 Metaplex JSON with the model slug attribute', async () => {
    const modelId = await createModel('llama-meta', 'https://img.example/llama.png');
    const mint = await prepare(modelId, 'LLAMA');

    const res = await request(t.app).get(`/metadata/${mint}.json`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(TokenMetadataSchema.parse(res.body)).toEqual({
      name: 'Model llama-meta',
      symbol: 'LLAMA',
      description: 'Fast llama',
      image: 'https://img.example/llama.png',
      external_url: `${t.env.WEB_ORIGIN}/t/llama-meta`,
      attributes: [{ trait_type: 'model', value: 'llama-meta' }],
    });
    expect(res.text).not.toContain('sk-meta-secret');
    expect(res.text).not.toContain('upstream');

    const bare = await request(t.app).get(`/metadata/${mint}`);
    expect(bare.status).toBe(200);
  });

  it('falls back to a symbol derived from the slug and an empty image', async () => {
    const modelId = await createModel('qwen-2.5-mini-fast');
    const mint = await prepare(modelId);
    const body = TokenMetadataSchema.parse(
      (await request(t.app).get(`/metadata/${mint}.json`)).body,
    );
    expect(body.symbol).toBe('QWEN25MINI');
    expect(body.image).toBe('');
  });

  it('an unknown or malformed mint returns 404', async () => {
    const unknown = await request(t.app).get(`/metadata/${base58Encode(randomBytes(32))}.json`);
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown).code).toBe('not_found');
    expect((await request(t.app).get('/metadata/not-a-mint.json')).status).toBe(404);
  });
});
