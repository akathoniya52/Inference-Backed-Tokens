import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Models, Types, adjust } from '@ibt/db';
import { createMockUpstream, type MockUpstream } from '@ibt/mock-upstream';
import { LedgerResponseSchema, MeResponseSchema } from '@ibt/shared';
import { encrypt } from '@ibt/shared/node';
import OpenAI, { AuthenticationError, BadRequestError } from 'openai';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createApiKey, makeTestApp, newWallet, signIn, type TestApp } from './helpers.js';

/**
 * Spec L597: a real OpenAI SDK call succeeds with only `baseURL` and `apiKey` changed.
 * The SDK talks to the api over a real HTTP socket; the upstream is the shared mock.
 */
describe('acceptance: OpenAI SDK against the gateway', () => {
  let t: TestApp;
  let mock: MockUpstream;
  let server: Server;
  let baseURL: string;
  let jwt: string;
  let key: string;
  let keyId: string;

  function sdk(apiKey: string): OpenAI {
    return new OpenAI({ baseURL, apiKey, maxRetries: 0 });
  }

  beforeAll(async () => {
    mock = await createMockUpstream({ port: 0 });
    t = await makeTestApp();
    server = await new Promise<Server>((resolve) => {
      const s = t.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    baseURL = `http://127.0.0.1:${port}/v1`;

    const providerJwt = await signIn(t.app, newWallet().keypair);
    const provider = await request(t.app).get('/api/me').set('Authorization', bearer(providerJwt));
    await Models.create({
      providerId: new Types.ObjectId(MeResponseSchema.parse(provider.body).id),
      slug: 'mock-llm',
      name: 'Mock LLM',
      upstream: {
        baseUrl: `${mock.url}/v1/`,
        modelName: 'mock-model',
        apiKeyEnc: encrypt('mock-key', t.env.MASTER_KEY),
      },
      pricing: { inputPerMTokMicroUsdc: 1_000_000n, outputPerMTokMicroUsdc: 2_000_000n },
    });

    jwt = await signIn(t.app, newWallet().keypair);
    const me = await request(t.app).get('/api/me').set('Authorization', bearer(jwt));
    await adjust(MeResponseSchema.parse(me.body).id, 10_000_000n, 'acceptance credit');
    const created = await createApiKey(t.app, jwt);
    key = created.key;
    keyId = created.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await t.close();
    await mock.close();
  });

  it('chat.completions.create returns choices and the ledger shows a capture', async () => {
    expect(key).toMatch(/^ibt_/);
    const completion = await sdk(key).chat.completions.create({
      model: 'mock-llm',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 64,
    });

    expect(completion.choices.length).toBeGreaterThan(0);
    expect(typeof completion.choices[0]?.message.content).toBe('string');
    expect(completion.usage?.total_tokens).toBeGreaterThan(0);

    const ledgerRes = await request(t.app)
      .get('/api/billing/ledger')
      .set('Authorization', bearer(jwt));
    const rows = LedgerResponseSchema.parse(ledgerRes.body).items;
    expect(rows.find((row) => row.type === 'hold')).toMatchObject({ status: 'captured' });
    expect(rows.some((row) => row.type === 'capture')).toBe(true);
  });

  it('models.list lists mock-llm', async () => {
    const ids: string[] = [];
    for await (const model of sdk(key).models.list()) ids.push(model.id);
    expect(ids).toContain('mock-llm');
  });

  it('stream: true surfaces a 400 invalid_request', async () => {
    const err: unknown = await sdk(key)
      .chat.completions.create({
        model: 'mock-llm',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ status: 400, code: 'invalid_request' });
  });

  it('a revoked key gets an AuthenticationError', async () => {
    const other = await createApiKey(t.app, jwt, { name: 'to revoke' });
    expect(other.id).not.toBe(keyId);
    const revoke = await request(t.app)
      .delete(`/api/keys/${other.id}`)
      .set('Authorization', bearer(jwt));
    expect(revoke.status).toBe(200);

    const err: unknown = await sdk(other.key)
      .chat.completions.create({
        model: 'mock-llm',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 64,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err).toMatchObject({ status: 401 });
  });
});
