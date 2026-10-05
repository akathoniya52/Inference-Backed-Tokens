import { Ledger, Models, Requests, Types, Users, adjust } from '@ibt/db';
import { createMockUpstream, type MockUpstream } from '@ibt/mock-upstream';
import {
  ChatCompletionResponseSchema,
  DEFAULT_MAX_TOKENS,
  LedgerResponseSchema,
  MeResponseSchema,
  microToUsdcString,
} from '@ibt/shared';
import { encrypt } from '@ibt/shared/node';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { countMessages, countPrompt } from '../src/modules/gateway/tokenCount.js';
import {
  bearer,
  createApiKey,
  errorOf,
  makeTestApp,
  newWallet,
  signIn,
  type TestApp,
} from './helpers.js';

const IN_PRICE = 1_000_000n;
const OUT_PRICE = 2_000_000n;
const FUNDED_MICRO = 10_000_000n;

interface Consumer {
  jwt: string;
  key: string;
  keyId: string;
  userId: string;
}

describe('gateway: non-streaming chat completions', () => {
  let t: TestApp;
  let mock: MockUpstream;

  async function userIdOf(jwt: string): Promise<string> {
    const me = await request(t.app).get('/api/me').set('Authorization', bearer(jwt));
    return MeResponseSchema.parse(me.body).id;
  }

  async function seedModel(slug: string, modelName: string): Promise<void> {
    const providerId = await userIdOf(await signIn(t.app, newWallet().keypair));
    await Models.create({
      providerId: new Types.ObjectId(providerId),
      slug,
      name: slug,
      upstream: {
        baseUrl: `${mock.url}/v1/`,
        modelName,
        apiKeyEnc: encrypt('mock-key', t.env.MASTER_KEY),
      },
      pricing: { inputPerMTokMicroUsdc: IN_PRICE, outputPerMTokMicroUsdc: OUT_PRICE },
    });
  }

  async function consumer(fundMicro = FUNDED_MICRO): Promise<Consumer> {
    const jwt = await signIn(t.app, newWallet().keypair);
    const userId = await userIdOf(jwt);
    if (fundMicro > 0n) await adjust(userId, fundMicro, 'test credit');
    const created = await createApiKey(t.app, jwt);
    return { jwt, key: created.key, keyId: created.id, userId };
  }

  function chat(key: string, body: object) {
    return request(t.app).post('/v1/chat/completions').set('Authorization', bearer(key)).send(body);
  }

  async function balances(userId: string) {
    const user = await Users.findById(userId).lean();
    if (!user) throw new Error('user missing');
    return { balance: user.balanceMicroUsdc, held: user.heldMicroUsdc };
  }

  const hello = [{ role: 'user' as const, content: 'Hello there, gateway' }];

  beforeAll(async () => {
    mock = await createMockUpstream({ port: 0, firstByteDelayMs: 5_000 });
    t = await makeTestApp({ timeouts: { firstByteMs: 100, totalMs: 2_000 } });
    await seedModel('gw-ok', 'upstream-ok');
    await seedModel('gw-500', 'upstream:error500');
    await seedModel('gw-malformed', 'upstream:malformed');
    await seedModel('gw-slow', 'upstream:slow-first-byte');
    await seedModel('gw-no-usage', 'upstream:no-usage');
  });

  afterAll(async () => {
    await t.close();
    await mock.close();
  });

  it('forwards, captures the actual cost and sets the billing headers', async () => {
    const c = await consumer();
    const res = await chat(c.key, { model: 'gw-ok', messages: hello, max_tokens: 64 });

    expect(res.status).toBe(200);
    const body = ChatCompletionResponseSchema.parse(res.body);
    expect(body.model).toBe('upstream-ok');
    const usage = body.usage;
    if (!usage) throw new Error('mock omitted usage');
    const cost =
      BigInt(usage.prompt_tokens) * (IN_PRICE / 1_000_000n) +
      BigInt(usage.completion_tokens) * (OUT_PRICE / 1_000_000n);

    const requestId = res.get('X-Request-Id');
    expect(requestId).toBeTruthy();
    expect(res.get('X-Cost-Usdc')).toBe(microToUsdcString(cost));
    expect(res.get('X-Balance-Usdc')).toBe(microToUsdcString(FUNDED_MICRO - cost));
    expect(res.get('X-Discount-Bps')).toBe('0');
    expect(await balances(c.userId)).toEqual({ balance: FUNDED_MICRO - cost, held: 0n });

    const upstreamCall = mock.calls.at(-1);
    expect(upstreamCall?.headers.authorization).toBe('Bearer mock-key');
    expect(upstreamCall?.body).toMatchObject({ model: 'upstream-ok', max_tokens: 64 });
    expect(res.text).not.toContain('mock-key');

    const ledgerRes = await request(t.app)
      .get('/api/billing/ledger')
      .set('Authorization', bearer(c.jwt));
    const ledger = LedgerResponseSchema.parse(ledgerRes.body).items;
    const holdRow = ledger.find((row) => row.type === 'hold');
    const captureRow = ledger.find((row) => row.type === 'capture');
    expect(holdRow).toMatchObject({ status: 'captured', ref: { requestId } });
    expect(captureRow).toMatchObject({
      amountUsdc: microToUsdcString(-cost),
      ref: { requestId, holdId: holdRow?.id },
    });

    const doc = await Requests.findOne({ requestId }).lean();
    expect(doc).toMatchObject({
      status: 'success',
      costMicroUsdc: cost,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      usageEstimated: false,
      settlementId: null,
      streamed: false,
      upstreamStatus: 200,
    });
    expect(doc?.userId.toHexString()).toBe(c.userId);
    expect(doc?.apiKeyId.toHexString()).toBe(c.keyId);
    expect(doc?.createdAt).toBeInstanceOf(Date);
  });

  it('echoes a supplied X-Request-Id and refuses to reuse it', async () => {
    const c = await consumer();
    const first = await chat(c.key, { model: 'gw-ok', messages: hello }).set(
      'X-Request-Id',
      'client-req-1',
    );
    expect(first.status).toBe(200);
    expect(first.get('X-Request-Id')).toBe('client-req-1');

    const again = await chat(c.key, { model: 'gw-ok', messages: hello }).set(
      'X-Request-Id',
      'client-req-1',
    );
    expect(again.status).toBe(400);
    expect(errorOf(again).code).toBe('invalid_request');
  });

  it('returns 402 with the shortfall when the balance is below the hold estimate', async () => {
    const c = await consumer(1_000n);
    const res = await chat(c.key, { model: 'gw-ok', messages: hello, max_tokens: 1000 });
    const estimate = BigInt(countMessages(hello)) + 1000n * 2n;

    expect(res.status).toBe(402);
    const error = errorOf(res);
    expect(error.code).toBe('insufficient_credits');
    expect(error.shortfallUsdc).toBe(microToUsdcString(estimate - 1_000n));
    expect(await Ledger.countDocuments({ userId: new Types.ObjectId(c.userId) })).toBe(1);
  });

  it.each([
    ['gw-500', 500],
    ['gw-malformed', 200],
  ])('%s → 502, hold released, nothing billed', async (model, upstreamStatus) => {
    const c = await consumer();
    const res = await chat(c.key, { model, messages: hello });

    expect(res.status).toBe(502);
    expect(errorOf(res).code).toBe('upstream_error');
    expect(await balances(c.userId)).toEqual({ balance: FUNDED_MICRO, held: 0n });
    const userId = new Types.ObjectId(c.userId);
    expect(await Ledger.countDocuments({ userId, type: 'capture' })).toBe(0);
    expect(await Ledger.countDocuments({ userId, type: 'release' })).toBe(1);
    expect(await Ledger.findOne({ userId, type: 'hold' }).lean()).toMatchObject({
      status: 'released',
    });
    const doc = await Requests.findOne({ requestId: res.get('X-Request-Id') }).lean();
    expect(doc).toMatchObject({ status: 'upstream_error', costMicroUsdc: 0n, upstreamStatus });
  });

  it('first-byte timeout → 504 and the hold is released', async () => {
    const c = await consumer();
    const started = Date.now();
    const res = await chat(c.key, { model: 'gw-slow', messages: hello });

    expect(res.status).toBe(504);
    expect(errorOf(res).code).toBe('upstream_timeout');
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(await balances(c.userId)).toEqual({ balance: FUNDED_MICRO, held: 0n });
    const doc = await Requests.findOne({ requestId: res.get('X-Request-Id') }).lean();
    expect(doc).toMatchObject({ status: 'timeout', costMicroUsdc: 0n });
  });

  it('counts tokens with tiktoken when the upstream omits usage', async () => {
    const c = await consumer();
    const res = await chat(c.key, { model: 'gw-no-usage', messages: hello });

    expect(res.status).toBe(200);
    const doc = await Requests.findOne({ requestId: res.get('X-Request-Id') }).lean();
    expect(doc?.usageEstimated).toBe(true);
    expect(doc?.promptTokens).toBe(countMessages(hello));
    expect(doc?.completionTokens).toBeGreaterThan(0);
    const cost = BigInt(doc?.promptTokens ?? 0) + 2n * BigInt(doc?.completionTokens ?? 0);
    expect(doc?.costMicroUsdc).toBe(cost);
    expect(res.get('X-Cost-Usdc')).toBe(microToUsdcString(cost));
  });

  it('rejects a revoked key with 401 before any hold', async () => {
    const c = await consumer();
    const revoke = await request(t.app)
      .delete(`/api/keys/${c.keyId}`)
      .set('Authorization', bearer(c.jwt));
    expect(revoke.status).toBe(200);

    const res = await chat(c.key, { model: 'gw-ok', messages: hello });
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('invalid_api_key');
    expect(
      await Ledger.countDocuments({ userId: new Types.ObjectId(c.userId), type: 'hold' }),
    ).toBe(0);
  });

  it('always sends the held completion limit upstream (A3)', async () => {
    const c = await consumer();
    const omitted = await chat(c.key, { model: 'gw-ok', messages: hello });
    expect(omitted.status).toBe(200);
    expect(mock.calls.at(-1)?.body).toMatchObject({ max_tokens: DEFAULT_MAX_TOKENS });
    expect(mock.calls.at(-1)?.body).not.toHaveProperty('max_completion_tokens');

    const modern = await chat(c.key, {
      model: 'gw-ok',
      messages: hello,
      max_completion_tokens: 16,
    });
    expect(modern.status).toBe(200);
    expect(mock.calls.at(-1)?.body).toMatchObject({ max_completion_tokens: 16 });
    expect(mock.calls.at(-1)?.body).not.toHaveProperty('max_tokens');

    const calls = mock.calls.length;
    const mismatched = await chat(c.key, {
      model: 'gw-ok',
      messages: hello,
      max_tokens: 8192,
      max_completion_tokens: 1,
    });
    expect(mismatched.status).toBe(400);
    expect(errorOf(mismatched).code).toBe('invalid_request');
    expect(mock.calls.length).toBe(calls);
    const userId = new Types.ObjectId(c.userId);
    expect(await Ledger.countDocuments({ userId, type: 'hold' })).toBe(2);
  });

  it('holds for tool definitions, not just message text (A4)', async () => {
    const c = await consumer();
    const tools = Array.from({ length: 20 }, (_, i) => ({
      type: 'function',
      function: {
        name: `tool_${i}`,
        description: 'Looks up the weather for a city and returns it as JSON. '.repeat(10),
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }));
    const plain = await chat(c.key, { model: 'gw-ok', messages: hello, max_tokens: 16 });
    const withTools = await chat(c.key, { model: 'gw-ok', messages: hello, max_tokens: 16, tools });
    expect(plain.status).toBe(200);
    expect(withTools.status).toBe(200);

    const holds = await Ledger.find({ userId: new Types.ObjectId(c.userId), type: 'hold' })
      .sort({ createdAt: 1 })
      .lean();
    const [plainHold, toolsHold] = holds.map((row) => -row.amountMicroUsdc);
    const toolTokens = BigInt(countPrompt({ model: 'gw-ok', messages: hello, tools }));
    expect(toolsHold).toBe(toolTokens + 16n * 2n);
    expect(toolsHold).toBeGreaterThan((plainHold ?? 0n) + 1_000n);
  });

  it('rejects a 200 KB whitespace-free prompt with 400 quickly and holds nothing (A5)', async () => {
    const c = await consumer();
    const started = Date.now();
    const res = await chat(c.key, {
      model: 'gw-ok',
      messages: [{ role: 'user', content: 'a'.repeat(200_000) }],
    });

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('invalid_request');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await Ledger.countDocuments({ userId: new Types.ObjectId(c.userId) })).toBe(1);
  });

  it('streams stream: true as server-sent events and captures it', async () => {
    const c = await consumer();
    const res = await chat(c.key, { model: 'gw-ok', messages: hello, stream: true });
    expect(res.status).toBe(200);
    expect(res.get('Content-Type')).toContain('text/event-stream');
    expect(res.text).toContain('data: [DONE]');
    const doc = await Requests.findOne({ requestId: res.get('X-Request-Id') }).lean();
    expect(doc).toMatchObject({ status: 'success', streamed: true });
    expect(await balances(c.userId)).toEqual({
      balance: FUNDED_MICRO - (doc?.costMicroUsdc ?? 0n),
      held: 0n,
    });
  });
});

describe('gateway: upstream address guard', () => {
  let t: TestApp;
  let mock: MockUpstream;

  beforeAll(async () => {
    mock = await createMockUpstream({ port: 0 });
    t = await makeTestApp({ env: { ALLOW_PRIVATE_UPSTREAMS: 'false' } });
    const provider = await signIn(t.app, newWallet().keypair);
    const me = await request(t.app).get('/api/me').set('Authorization', bearer(provider));
    await Models.create({
      providerId: new Types.ObjectId(MeResponseSchema.parse(me.body).id),
      slug: 'gw-private',
      name: 'gw-private',
      upstream: {
        baseUrl: `${mock.url}/v1`,
        modelName: 'upstream-ok',
        apiKeyEnc: encrypt('mock-key', t.env.MASTER_KEY),
      },
      pricing: { inputPerMTokMicroUsdc: IN_PRICE, outputPerMTokMicroUsdc: OUT_PRICE },
    });
  });

  afterAll(async () => {
    await t.close();
    await mock.close();
  });

  it.each([false, true])(
    'refuses a loopback upstream and releases the hold (stream: %s)',
    async (stream) => {
      const jwt = await signIn(t.app, newWallet().keypair);
      const me = await request(t.app).get('/api/me').set('Authorization', bearer(jwt));
      const userId = MeResponseSchema.parse(me.body).id;
      await adjust(userId, FUNDED_MICRO, 'test credit');
      const { key } = await createApiKey(t.app, jwt);

      const res = await request(t.app)
        .post('/v1/chat/completions')
        .set('Authorization', bearer(key))
        .send({
          model: 'gw-private',
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 8,
          stream,
        });
      expect(res.status).toBe(502);
      expect(errorOf(res).code).toBe('upstream_error');
      const user = await Users.findById(userId).lean();
      expect(user?.balanceMicroUsdc).toBe(FUNDED_MICRO);
      expect(user?.heldMicroUsdc).toBe(0n);
    },
  );
});
