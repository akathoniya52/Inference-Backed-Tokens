import { Idempotency, Ledger, Models, Requests, Types, adjust, claimIdempotencyRow } from '@ibt/db';
import { createMockUpstream, type MockUpstream } from '@ibt/mock-upstream';
import { ChatCompletionResponseSchema, MeResponseSchema } from '@ibt/shared';
import { encrypt } from '@ibt/shared/node';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { requestHash } from '../src/modules/gateway/idempotency.js';
import { SseCompletionParser } from '../src/modules/gateway/sse.js';

import {
  bearer,
  createApiKey,
  errorOf,
  makeTestApp,
  newWallet,
  signIn,
  type TestApp,
} from './helpers.js';

interface Consumer {
  key: string;
  userId: Types.ObjectId;
}

describe('gateway: idempotency keys', () => {
  let t: TestApp;
  let mock: MockUpstream;

  const hello = [{ role: 'user' as const, content: 'Idempotent hello' }];

  async function seedModel(slug: string, modelName: string): Promise<void> {
    const jwt = await signIn(t.app, newWallet().keypair);
    const me = await request(t.app).get('/api/me').set('Authorization', bearer(jwt));
    await Models.create({
      providerId: new Types.ObjectId(MeResponseSchema.parse(me.body).id),
      slug,
      name: slug,
      upstream: {
        baseUrl: `${mock.url}/v1`,
        modelName,
        apiKeyEnc: encrypt('mock-key', t.env.MASTER_KEY),
        supportsStreamUsage: true,
      },
      pricing: { inputPerMTokMicroUsdc: 1_000_000n, outputPerMTokMicroUsdc: 2_000_000n },
    });
  }

  async function consumer(): Promise<Consumer> {
    const jwt = await signIn(t.app, newWallet().keypair);
    const me = await request(t.app).get('/api/me').set('Authorization', bearer(jwt));
    const userId = MeResponseSchema.parse(me.body).id;
    await adjust(userId, 10_000_000n, 'test credit');
    return { key: (await createApiKey(t.app, jwt)).key, userId: new Types.ObjectId(userId) };
  }

  function chat(c: Consumer, idempotencyKey: string, body: object) {
    return request(t.app)
      .post('/v1/chat/completions')
      .set('Authorization', bearer(c.key))
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  }

  async function counts(userId: Types.ObjectId) {
    return {
      holds: await Ledger.countDocuments({ userId, type: 'hold' }),
      captures: await Ledger.countDocuments({ userId, type: 'capture' }),
      requests: await Requests.countDocuments({ userId }),
    };
  }

  beforeAll(async () => {
    mock = await createMockUpstream({ port: 0, firstByteDelayMs: 400 });
    t = await makeTestApp({ timeouts: { firstByteMs: 5_000, totalMs: 10_000 } });
    await seedModel('idem-ok', 'upstream-ok');
    await seedModel('idem-slow', 'upstream:slow-first-byte');
    await seedModel('idem-flaky', 'upstream:error500');
    await seedModel('idem-cut', 'upstream:stream-no-done');
  });

  afterAll(async () => {
    await t.close();
    await mock.close();
  });

  it('replays the stored response for a repeated key and bills once', async () => {
    const c = await consumer();
    const body = { model: 'idem-ok', messages: hello, max_tokens: 32 };
    const first = await chat(c, 'order-1', body);
    const second = await chat(c, 'order-1', body);

    expect(first.status).toBe(200);
    expect(first.get('Idempotency-Replayed')).toBeUndefined();
    expect(second.status).toBe(200);
    expect(second.get('Idempotency-Replayed')).toBe('true');
    expect(second.text).toBe(first.text);
    for (const header of ['X-Cost-Usdc', 'X-Balance-Usdc', 'X-Discount-Bps']) {
      expect(second.get(header)).toBe(first.get(header));
    }
    expect(await counts(c.userId)).toEqual({ holds: 1, captures: 1, requests: 1 });
    expect(await Requests.findOne({ userId: c.userId }).lean()).toMatchObject({
      idempotencyKey: 'order-1',
    });
  });

  it('a concurrent duplicate gets 409 idempotency_in_progress', async () => {
    const c = await consumer();
    const body = { model: 'idem-slow', messages: hello, max_tokens: 32 };
    const results = await Promise.all([chat(c, 'race', body), chat(c, 'race', body)]);

    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409]);
    const conflict = results.find((res) => res.status === 409);
    expect(conflict && errorOf(conflict).code).toBe('idempotency_in_progress');
    expect(await counts(c.userId)).toEqual({ holds: 1, captures: 1, requests: 1 });
  });

  it('the same key from two users never collides', async () => {
    const a = await consumer();
    const b = await consumer();
    const body = { model: 'idem-ok', messages: hello };
    const resA = await chat(a, 'shared-key', body);
    const resB = await chat(b, 'shared-key', body);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resB.get('Idempotency-Replayed')).toBeUndefined();
    expect((await counts(a.userId)).captures).toBe(1);
    expect((await counts(b.userId)).captures).toBe(1);
  });

  it('a failed call frees the key so a retry runs and bills', async () => {
    const c = await consumer();
    const body = { model: 'idem-flaky', messages: hello };
    const failed = await chat(c, 'retry-me', body);
    expect(failed.status).toBe(502);
    expect(await Idempotency.countDocuments({ userId: c.userId, key: 'retry-me' })).toBe(0);

    await Models.updateOne({ slug: 'idem-flaky' }, { $set: { 'upstream.modelName': 'up-ok' } });
    const retried = await chat(c, 'retry-me', body);
    expect(retried.status).toBe(200);
    expect(retried.get('Idempotency-Replayed')).toBeUndefined();
    expect((await counts(c.userId)).captures).toBe(1);
  });

  it('a streamed call is replayed as the assembled JSON completion', async () => {
    const c = await consumer();
    const body = { model: 'idem-ok', messages: hello, stream: true };
    const first = await chat(c, 'stream-1', body);
    expect(first.status).toBe(200);
    expect(first.get('Content-Type')).toContain('text/event-stream');

    const replay = await chat(c, 'stream-1', body);
    expect(replay.status).toBe(200);
    expect(replay.get('Idempotency-Replayed')).toBe('true');
    expect(replay.get('Content-Type')).toContain('application/json');
    const completion = ChatCompletionResponseSchema.parse(replay.body);
    expect(completion.choices[0]?.message.content).toBe('Echo: Idempotent hello');
    const doc = await Requests.findOne({ userId: c.userId }).lean();
    expect(completion.usage).toMatchObject({
      prompt_tokens: doc?.promptTokens,
      completion_tokens: doc?.completionTokens,
    });
    expect(replay.get('X-Cost-Usdc')).toBeDefined();
    expect(await counts(c.userId)).toEqual({ holds: 1, captures: 1, requests: 1 });
  });

  it('a stream billed but cut short never frees its key (GW-05)', async () => {
    const c = await consumer();
    const body = { model: 'idem-cut', messages: hello, stream: true };
    const first = await chat(c, 'cut-1', body);
    expect(first.status).toBe(200);
    expect(await counts(c.userId)).toEqual({ holds: 1, captures: 1, requests: 1 });

    const retry = await chat(c, 'cut-1', body);
    expect(retry.status).toBe(400);
    expect(retry.get('Idempotency-Replayed')).toBe('true');
    expect(errorOf(retry).message).toContain('cannot be replayed');
    expect(retry.get('X-Cost-Usdc')).toBeDefined();
    expect(await counts(c.userId)).toEqual({ holds: 1, captures: 1, requests: 1 });
  });

  it('an error after a stream was captured keeps its key locked, so a retry bills once', async () => {
    const c = await consumer();
    const body = { model: 'idem-ok', messages: hello, stream: true };
    const spy = vi.spyOn(SseCompletionParser.prototype, 'assemble').mockImplementationOnce(() => {
      throw new Error('assemble failed');
    });
    await chat(c, 'assemble-fails', body).catch(() => undefined);
    spy.mockRestore();
    expect(await counts(c.userId)).toEqual({ holds: 1, captures: 1, requests: 1 });

    const retry = await chat(c, 'assemble-fails', body);
    expect(retry.status).toBe(400);
    expect(retry.get('Idempotency-Replayed')).toBe('true');
    expect(errorOf(retry).message).toContain('cannot be replayed');
    expect(await counts(c.userId)).toEqual({ holds: 1, captures: 1, requests: 1 });
  });

  it('a billed call whose response cannot be stored keeps its key locked (GW-05)', async () => {
    const c = await consumer();
    const body = { model: 'idem-ok', messages: hello };
    const spy = vi.spyOn(Idempotency, 'updateOne').mockRejectedValueOnce(new Error('db blip'));
    const first = await chat(c, 'store-fails', body);
    spy.mockRestore();
    expect(first.status).toBe(200);
    const retry = await chat(c, 'store-fails', body);
    expect(retry.status).toBe(409);
    expect(errorOf(retry).code).toBe('idempotency_in_progress');
    expect((await counts(c.userId)).captures).toBe(1);
  });

  it('a claim whose process died is taken over once its lock expires (GW-06)', async () => {
    const c = await consumer();
    const body = { model: 'idem-ok', messages: hello };
    const hash = requestHash(body);
    await claimIdempotencyRow(c.userId, 'crashed', hash, {
      lockMs: 1_000,
      now: new Date(t.clock.now().getTime() - 60_000),
    });
    const res = await chat(c, 'crashed', body);
    expect(res.status).toBe(200);
    expect(res.get('Idempotency-Replayed')).toBeUndefined();
    const replay = await chat(c, 'crashed', body);
    expect(replay.get('Idempotency-Replayed')).toBe('true');
    expect((await counts(c.userId)).captures).toBe(1);

    // A live lock still answers 409.
    await claimIdempotencyRow(c.userId, 'live', hash, { lockMs: 600_000, now: t.clock.now() });
    expect((await chat(c, 'live', body)).status).toBe(409);
  });

  it('hashes the body canonically, so key order does not matter (GW-11)', async () => {
    const c = await consumer();
    const first = await chat(c, 'order', { model: 'idem-ok', messages: hello, max_tokens: 16 });
    expect(first.status).toBe(200);
    const reordered = await chat(c, 'order', {
      max_tokens: 16,
      messages: [{ content: 'Idempotent hello', role: 'user' }],
      model: 'idem-ok',
    });
    expect(reordered.status).toBe(200);
    expect(reordered.get('Idempotency-Replayed')).toBe('true');
    expect(requestHash({ a: 1, b: { c: [1, { e: 2, d: 3 }] } })).toBe(
      requestHash({ b: { c: [1, { d: 3, e: 2 }] }, a: 1 }),
    );
    expect(requestHash({ a: [1, 2] })).not.toBe(requestHash({ a: [2, 1] }));
  });

  it('rejects a reused key with a different body and an over-long key', async () => {
    const c = await consumer();
    const ok = await chat(c, 'body-bound', { model: 'idem-ok', messages: hello });
    expect(ok.status).toBe(200);
    const other = await chat(c, 'body-bound', {
      model: 'idem-ok',
      messages: [{ role: 'user', content: 'something else' }],
    });
    expect(other.status).toBe(400);
    expect(errorOf(other).code).toBe('invalid_request');

    const long = await chat(c, 'k'.repeat(256), { model: 'idem-ok', messages: hello });
    expect(long.status).toBe(400);
    expect(await counts(c.userId)).toEqual({ holds: 1, captures: 1, requests: 1 });
  });
});
