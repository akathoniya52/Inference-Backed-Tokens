import { Deposits, Models, Requests, Types } from '@ibt/db';
import {
  DepositResponseSchema,
  LedgerResponseSchema,
  MeResponseSchema,
  UsageResponseSchema,
} from '@ibt/shared';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildDepositTx, randomSignature as newSignature } from './depositTx.js';
import { bearer, errorOf, makeTestApp, newWallet, signIn, type TestApp } from './helpers.js';

const logLines: string[] = [];
const logger = pino({ level: 'info' }, { write: (line: string) => logLines.push(line) });

describe('billing', () => {
  let t: TestApp;
  let jwt: string;
  let userId: string;
  let depositRef: string;

  function depositTx(signature: string, memo: string) {
    return buildDepositTx({ signature, memo, treasuryWallet: t.env.TREASURY_WALLET });
  }

  function deposit(txSignature: string, token = jwt) {
    return request(t.app)
      .post('/api/billing/deposits')
      .set('Authorization', bearer(token))
      .send({ txSignature });
  }

  beforeAll(async () => {
    t = await makeTestApp({ logger });
    jwt = await signIn(t.app, newWallet().keypair);
    const res = await request(t.app).get('/api/me').set('Authorization', bearer(jwt));
    const profile = MeResponseSchema.parse(res.body);
    userId = profile.id;
    depositRef = profile.depositRef;
  });

  afterAll(async () => {
    await t.close();
  });

  it('GET /api/me returns profile, zero balance and the deposit reference', async () => {
    const res = await request(t.app).get('/api/me').set('Authorization', bearer(jwt));
    expect(res.status).toBe(200);
    expect(MeResponseSchema.parse(res.body)).toMatchObject({
      id: userId,
      role: 'consumer',
      depositRef,
      balanceUsdc: '0.000000',
      heldUsdc: '0.000000',
      availableUsdc: '0.000000',
    });
    expect((await request(t.app).get('/api/me')).status).toBe(401);
  });

  it('credits a finalized deposit once; a replay gets 409', async () => {
    const sig = newSignature();
    t.chain.setParsedTx(sig, depositTx(sig, depositRef));

    const res = await deposit(sig);
    expect(res.status).toBe(200);
    expect(DepositResponseSchema.parse(res.body)).toEqual({
      credited: true,
      amountUsdc: '25.000000',
      balanceUsdc: '25.000000',
    });
    const row = await Deposits.findOne({ txSignature: sig }).lean();
    expect(row).toMatchObject({ status: 'credited', amountMicroUsdc: 25_000_000n });

    const replay = await deposit(sig);
    expect(replay.status).toBe(409);
    expect(errorOf(replay).code).toBe('deposit_already_credited');

    const other = await signIn(t.app, newWallet().keypair);
    expect((await deposit(sig, other)).status).toBe(409);

    const me = MeResponseSchema.parse(
      (await request(t.app).get('/api/me').set('Authorization', bearer(jwt))).body,
    );
    expect(me.balanceUsdc).toBe('25.000000');
  });

  it('a wrong memo is 422 deposit_invalid with a rejected row and a log line', async () => {
    const sig = newSignature();
    t.chain.setParsedTx(sig, depositTx(sig, 'not-my-ref'));
    const res = await deposit(sig);
    expect(res.status).toBe(422);
    expect(errorOf(res)).toMatchObject({
      code: 'deposit_invalid',
      message: 'memo does not match depositRef',
    });
    const row = await Deposits.findOne({ txSignature: sig }).lean();
    expect(row).toMatchObject({ status: 'rejected', reason: 'memo_mismatch' });
    expect(logLines.some((line) => line.includes('deposit rejected') && line.includes(sig))).toBe(
      true,
    );
  });

  it('confirmed but not finalized is 202 deposit_pending with no rejected row, then credits', async () => {
    const sig = newSignature();
    const status = vi.spyOn(t.chain, 'signatureStatus').mockResolvedValue('landed');
    const pending = await deposit(sig);
    expect(pending.status).toBe(202);
    expect(errorOf(pending).code).toBe('deposit_pending');
    expect(await Deposits.countDocuments({ txSignature: sig })).toBe(0);
    status.mockRestore();

    t.chain.setParsedTx(sig, depositTx(sig, depositRef));
    const credited = await deposit(sig);
    expect(credited.status).toBe(200);
    expect(DepositResponseSchema.parse(credited.body).amountUsdc).toBe('25.000000');
    expect(await Deposits.countDocuments({ txSignature: sig, status: 'rejected' })).toBe(0);
  });

  it('an unknown signature is retryable, never recorded, and a later finalized tx credits (API-09)', async () => {
    const sig = newSignature();
    const alertsBefore = t.alerter.alerts.length;
    const missing = await deposit(sig);
    expect(missing.status).toBe(202);
    expect(errorOf(missing).code).toBe('deposit_pending');
    expect(await Deposits.countDocuments({ txSignature: sig })).toBe(0);
    expect(t.alerter.alerts.length).toBe(alertsBefore);

    t.chain.setParsedTx(sig, depositTx(sig, depositRef));
    expect((await deposit(sig)).status).toBe(200);
    const rows = await Deposits.find({ txSignature: sig }).lean();
    expect(rows.map((row) => row.status)).toEqual(['credited']);
  });

  it('rejects a malformed signature with 400', async () => {
    const res = await deposit('not-a-signature');
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('invalid_request');
  });

  it('GET /api/billing/ledger pages newest first with an opaque cursor', async () => {
    const first = await request(t.app)
      .get('/api/billing/ledger')
      .query({ limit: 2 })
      .set('Authorization', bearer(jwt));
    expect(first.status).toBe(200);
    const page = LedgerResponseSchema.parse(first.body);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ type: 'deposit', amountUsdc: '25.000000' });
    expect(page.items[0]?.ref.txSignature).toBeDefined();
    expect(page.nextCursor).not.toBeNull();

    const second = await request(t.app)
      .get('/api/billing/ledger')
      .query({ limit: 2, cursor: page.nextCursor })
      .set('Authorization', bearer(jwt));
    const rest = LedgerResponseSchema.parse(second.body);
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    expect(rest.items[0]?.balanceAfterUsdc).toBe('25.000000');

    const tooBig = await request(t.app)
      .get('/api/billing/ledger?limit=101')
      .set('Authorization', bearer(jwt));
    expect(tooBig.status).toBe(400);
    const badCursor = await request(t.app)
      .get('/api/billing/ledger?cursor=zzz')
      .set('Authorization', bearer(jwt));
    expect(badCursor.status).toBe(400);
  });

  it('GET /api/billing/usage aggregates per model per UTC day', async () => {
    const model = await Models.create({
      providerId: new Types.ObjectId(),
      slug: 'usage-model',
      name: 'Usage Model',
      upstream: { baseUrl: 'http://127.0.0.1:1/v1', modelName: 'm', apiKeyEnc: 'x' },
      pricing: { inputPerMTokMicroUsdc: 1n, outputPerMTokMicroUsdc: 1n },
    });
    const base = {
      userId: new Types.ObjectId(userId),
      apiKeyId: new Types.ObjectId(),
      modelId: model._id,
      status: 'success',
      usageEstimated: false,
      discountBps: 0,
      latencyMs: 10,
      streamed: false,
      settlementId: null,
    };
    await Requests.collection.insertMany([
      {
        ...base,
        requestId: 'u1',
        promptTokens: 10,
        completionTokens: 5,
        costMicroUsdc: 1_500n,
        createdAt: new Date('2026-09-01T01:00:00Z'),
      },
      {
        ...base,
        requestId: 'u2',
        promptTokens: 20,
        completionTokens: 7,
        costMicroUsdc: 2_500n,
        createdAt: new Date('2026-09-01T23:00:00Z'),
      },
      {
        ...base,
        requestId: 'u3',
        promptTokens: 1,
        completionTokens: 1,
        costMicroUsdc: 100n,
        createdAt: new Date('2026-09-02T00:30:00Z'),
      },
      {
        ...base,
        userId: new Types.ObjectId(),
        requestId: 'u4',
        promptTokens: 99,
        completionTokens: 99,
        costMicroUsdc: 99n,
        createdAt: new Date('2026-09-01T02:00:00Z'),
      },
    ]);

    const res = await request(t.app)
      .get('/api/billing/usage')
      .query({ from: '2026-09-01', to: '2026-09-01' })
      .set('Authorization', bearer(jwt));
    expect(res.status).toBe(200);
    const body = UsageResponseSchema.parse(res.body);
    expect(body.from).toBe('2026-09-01T00:00:00.000Z');
    expect(body.to).toBe('2026-09-02T00:00:00.000Z');
    expect(body.items).toEqual([
      {
        date: '2026-09-01',
        modelId: model._id.toHexString(),
        modelSlug: 'usage-model',
        requests: 2,
        promptTokens: 30,
        completionTokens: 12,
        costUsdc: '0.004000',
      },
    ]);

    const both = UsageResponseSchema.parse(
      (
        await request(t.app)
          .get('/api/billing/usage')
          .query({ from: '2026-09-01T00:00:00Z', to: '2026-09-03T00:00:00Z' })
          .set('Authorization', bearer(jwt))
      ).body,
    );
    expect(both.items.map((row) => [row.date, row.requests])).toEqual([
      ['2026-09-01', 2],
      ['2026-09-02', 1],
    ]);

    const inverted = await request(t.app)
      .get('/api/billing/usage')
      .query({ from: '2026-09-03', to: '2026-09-01' })
      .set('Authorization', bearer(jwt));
    expect(inverted.status).toBe(400);

    // API-11: a date-only `to` covers its whole day, so a same-day range is valid.
    const sameDay = await request(t.app)
      .get('/api/billing/usage')
      .query({ from: '2026-09-01T12:00:00Z', to: '2026-09-01' })
      .set('Authorization', bearer(jwt));
    expect(sameDay.status).toBe(200);
    expect(UsageResponseSchema.parse(sameDay.body)).toMatchObject({
      from: '2026-09-01T12:00:00.000Z',
      to: '2026-09-02T00:00:00.000Z',
    });
  });
});
