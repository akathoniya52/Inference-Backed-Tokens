import { Writable } from 'node:stream';

import { Models, Requests, Types, adjust } from '@ibt/db';
import { createMockUpstream, type MockUpstream } from '@ibt/mock-upstream';
import {
  HOLDER_BALANCE_CACHE_MS,
  HOLDER_DISCOUNT_BPS,
  HOLDER_MIN_BASE_UNITS,
  MeResponseSchema,
  applyDiscount,
  microToUsdcString,
} from '@ibt/shared';
import { encrypt } from '@ibt/shared/node';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { toPublicKey } from '../src/lib/publicKey.js';
import { bearer, createApiKey, makeTestApp, newWallet, signIn, type TestApp } from './helpers.js';

interface Consumer {
  key: string;
  wallet: string;
}

describe('gateway: token holder discount', () => {
  let t: TestApp;
  let mock: MockUpstream;
  const mint = newWallet().wallet;
  const logLines: string[] = [];

  const hello = [{ role: 'user' as const, content: 'Discount me, holder' }];

  async function seedModel(slug: string, token: object): Promise<void> {
    const jwt = await signIn(t.app, newWallet().keypair);
    const me = await request(t.app).get('/api/me').set('Authorization', bearer(jwt));
    await Models.create({
      providerId: new Types.ObjectId(MeResponseSchema.parse(me.body).id),
      slug,
      name: slug,
      upstream: {
        baseUrl: `${mock.url}/v1`,
        modelName: 'upstream-ok',
        apiKeyEnc: encrypt('mock-key', t.env.MASTER_KEY),
      },
      pricing: { inputPerMTokMicroUsdc: 10_000_000n, outputPerMTokMicroUsdc: 30_000_000n },
      token,
    });
  }

  async function consumer(tokens = 0n): Promise<Consumer> {
    const { keypair, wallet } = newWallet();
    const jwt = await signIn(t.app, keypair);
    const me = await request(t.app).get('/api/me').set('Authorization', bearer(jwt));
    await adjust(MeResponseSchema.parse(me.body).id, 10_000_000n, 'test credit');
    if (tokens > 0n) t.chain.setBalance(toPublicKey(wallet), toPublicKey(mint), tokens);
    return { key: (await createApiKey(t.app, jwt)).key, wallet };
  }

  function chat(c: Consumer, model = 'disc-curve') {
    return request(t.app)
      .post('/v1/chat/completions')
      .set('Authorization', bearer(c.key))
      .send({ model, messages: hello, max_tokens: 32 });
  }

  function balanceReads(wallet: string): number {
    const owner = toPublicKey(wallet);
    return t.chain.calls.filter(
      (call) => call.method === 'tokenBalance' && owner.equals(call.args[0] as typeof owner),
    ).length;
  }

  async function docOf(requestId: string) {
    const doc = await Requests.findOne({ requestId }).lean();
    if (!doc) throw new Error(`request ${requestId} missing`);
    return doc;
  }

  beforeAll(async () => {
    mock = await createMockUpstream({ port: 0 });
    const logger = pino(
      { level: 'warn' },
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          logLines.push(chunk.toString());
          callback();
        },
      }),
    );
    t = await makeTestApp({ logger });
    await seedModel('disc-curve', { status: 'curve', mint });
    await seedModel('disc-none', { status: 'none' });
  });

  afterAll(async () => {
    await t.close();
    await mock.close();
  });

  it('a holder pays 90% of what a non-holder pays for the same call', async () => {
    const holder = await consumer(HOLDER_MIN_BASE_UNITS);
    const other = await consumer(HOLDER_MIN_BASE_UNITS - 1n);
    const paid = await chat(holder);
    const full = await chat(other);

    expect(paid.status).toBe(200);
    expect(full.status).toBe(200);
    expect(paid.get('X-Discount-Bps')).toBe(String(HOLDER_DISCOUNT_BPS));
    expect(full.get('X-Discount-Bps')).toBe('0');

    const paidDoc = await docOf(paid.get('X-Request-Id') ?? '');
    const fullDoc = await docOf(full.get('X-Request-Id') ?? '');
    expect(paidDoc.discountBps).toBe(HOLDER_DISCOUNT_BPS);
    expect(fullDoc.discountBps).toBe(0);
    expect(paidDoc.promptTokens).toBe(fullDoc.promptTokens);
    expect(paidDoc.completionTokens).toBe(fullDoc.completionTokens);
    expect(fullDoc.costMicroUsdc).toBeGreaterThan(0n);
    expect(paidDoc.costMicroUsdc).toBe(applyDiscount(fullDoc.costMicroUsdc, HOLDER_DISCOUNT_BPS));
    expect(paid.get('X-Cost-Usdc')).toBe(microToUsdcString(paidDoc.costMicroUsdc));
  });

  it('reads the balance once per 5 minutes per wallet and mint', async () => {
    const holder = await consumer(HOLDER_MIN_BASE_UNITS);
    expect((await chat(holder)).status).toBe(200);
    expect((await chat(holder)).status).toBe(200);
    expect(balanceReads(holder.wallet)).toBe(1);

    t.clock.advance(HOLDER_BALANCE_CACHE_MS + 1_000);
    const later = await chat(holder);
    expect(later.status).toBe(200);
    expect(later.get('X-Discount-Bps')).toBe(String(HOLDER_DISCOUNT_BPS));
    expect(balanceReads(holder.wallet)).toBe(2);
  });

  it('a model without a live token never reads the chain', async () => {
    const holder = await consumer(HOLDER_MIN_BASE_UNITS);
    const res = await chat(holder, 'disc-none');
    expect(res.status).toBe(200);
    expect(res.get('X-Discount-Bps')).toBe('0');
    expect(balanceReads(holder.wallet)).toBe(0);
  });

  it('a failed balance read means no discount, no error and one warning', async () => {
    const holder = await consumer(HOLDER_MIN_BASE_UNITS);
    const spy = vi.spyOn(t.chain, 'tokenBalance').mockRejectedValueOnce(new Error('rpc down'));
    const warningsBefore = logLines.filter((line) => line.includes('holder balance')).length;
    const res = await chat(holder);
    spy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.get('X-Discount-Bps')).toBe('0');
    expect((await docOf(res.get('X-Request-Id') ?? '')).discountBps).toBe(0);
    const warnings = logLines.filter((line) => line.includes('holder balance'));
    expect(warnings).toHaveLength(warningsBefore + 1);
    expect(warnings.at(-1)).not.toContain('mock-key');
  });
});
