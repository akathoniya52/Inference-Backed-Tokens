import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { Models, Types } from '@ibt/db';
import { MeResponseSchema } from '@ibt/shared';
import type { Alerter } from '@ibt/shared/node';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ERROR_RATE_MIN_SAMPLE,
  ERROR_RATE_WINDOW_MS,
  REJECTED_DEPOSITS_WINDOW_MS,
  createApiAlerts,
} from '../src/alerts.js';
import { base58Encode } from '../src/lib/base58.js';
import { buildDepositTx } from './depositTx.js';
import {
  bearer,
  createRecordingAlerter,
  createTestClock,
  makeTestApp,
  newWallet,
  signIn,
  type TestApp,
} from './helpers.js';

const silent = pino({ level: 'silent' });

function setup() {
  const clock = createTestClock(new Date('2026-10-02T12:00:00Z'));
  const alerter = createRecordingAlerter();
  const alerts = createApiAlerts({ alerter, clock: () => clock.now(), logger: silent });
  const record = (status: number, times = 1) => {
    for (let i = 0; i < times; i += 1) alerts.recordResponse(status);
  };
  return { clock, alerter, alerts, record };
}

describe('rolling alert counters (unit, fake clock)', () => {
  it(`5xx rate: never alerts below ${ERROR_RATE_MIN_SAMPLE} responses in the window`, () => {
    const { alerter, record } = setup();
    record(500, ERROR_RATE_MIN_SAMPLE - 1);
    expect(alerter.alerts).toHaveLength(0);
    record(500);
    expect(alerter.alerts).toHaveLength(1);
  });

  it('5xx rate: alerts once above 2% over 5 minutes and re-arms after it clears', () => {
    const { clock, alerter, record } = setup();
    record(200, 98);
    record(502, 2);
    expect(alerter.alerts).toHaveLength(0); // exactly 2% is not above 2%

    record(504);
    expect(alerter.alerts).toHaveLength(1);
    expect(alerter.alerts[0]).toMatchObject({
      level: 'error',
      title: '5xx rate above 2% over 5 minutes',
      body: { errors: 3, total: 101 },
    });
    record(500, 5);
    expect(alerter.alerts).toHaveLength(1);

    clock.advance(ERROR_RATE_WINDOW_MS + 1);
    record(200, 60);
    expect(alerter.alerts).toHaveLength(1);
    record(500);
    expect(alerter.alerts).toHaveLength(1); // 1 of 61 is 1.6%
    record(500);
    expect(alerter.alerts).toHaveLength(2);
    expect(alerter.alerts[1]?.body).toMatchObject({ errors: 2, total: 62 });
  });

  it('5xx rate: old responses leave the window', () => {
    const { clock, alerter, record } = setup();
    record(500, 3);
    clock.advance(ERROR_RATE_WINDOW_MS + 1);
    record(200, 100);
    expect(alerter.alerts).toHaveLength(0);
  });

  it('rejected deposits: alerts on the 6th within an hour, once, then re-arms', () => {
    const { clock, alerter, alerts } = setup();
    for (let i = 0; i < 5; i += 1) {
      alerts.recordRejectedDeposit();
      clock.advance(60_000);
    }
    expect(alerter.alerts).toHaveLength(0);
    alerts.recordRejectedDeposit();
    alerts.recordRejectedDeposit();
    expect(alerter.alerts).toEqual([
      { level: 'warn', title: 'more than 5 rejected deposits in an hour', body: { count: 6 } },
    ]);

    clock.advance(REJECTED_DEPOSITS_WINDOW_MS + 1);
    for (let i = 0; i < 5; i += 1) alerts.recordRejectedDeposit();
    expect(alerter.alerts).toHaveLength(1);
    alerts.recordRejectedDeposit();
    expect(alerter.alerts).toHaveLength(2);
  });

  it('rejections spread over more than an hour never alert', () => {
    const { clock, alerter, alerts } = setup();
    for (let i = 0; i < 20; i += 1) {
      alerts.recordRejectedDeposit();
      clock.advance(REJECTED_DEPOSITS_WINDOW_MS / 5);
    }
    expect(alerter.alerts).toHaveLength(0);
  });

  it('model paused alerts every time with the event body', () => {
    const { alerter, alerts } = setup();
    alerts.modelPaused({ modelId: 'm1', slug: 'llama', reason: 'admin' });
    alerts.modelPaused({ modelId: 'm1', slug: 'llama', reason: 'owner' });
    expect(alerter.alerts).toEqual([
      {
        level: 'error',
        title: 'model paused',
        body: { modelId: 'm1', slug: 'llama', reason: 'admin' },
      },
      {
        level: 'error',
        title: 'model paused',
        body: { modelId: 'm1', slug: 'llama', reason: 'owner' },
      },
    ]);
  });

  it('a response marked failed after its headers counts as a 5xx, once (API-12)', () => {
    const { alerter, alerts, record } = setup();
    const middleware = alerts.middleware();
    record(200, ERROR_RATE_MIN_SAMPLE - 2);
    for (let i = 0; i < 2; i += 1) {
      const res = Object.assign(new EventEmitter(), { statusCode: 200 });
      const next = vi.fn();
      middleware(
        {} as Parameters<typeof middleware>[0],
        res as unknown as Parameters<typeof middleware>[1],
        next,
      );
      expect(next).toHaveBeenCalledOnce();
      alerts.markFailed(res);
      // A destroyed response emits only `close`; `finish` after it must not count twice.
      res.emit('close');
      res.emit('finish');
    }
    expect(alerter.alerts.map((a) => a.body)).toEqual([
      { errors: 2, total: ERROR_RATE_MIN_SAMPLE, ratePct: 4 },
    ]);
  });

  it('keeps one counter per second however many responses arrive (API-13)', () => {
    const { clock, alerter, record } = setup();
    record(200, 100_000);
    clock.advance(ERROR_RATE_WINDOW_MS - 1_000);
    record(500, 3);
    expect(alerter.alerts.map((a) => a.body)).toEqual([]);
    clock.advance(2_000);
    record(500, 3);
    // The 100k successes left the window: 6 of 6 failed, but below the sample floor.
    expect(alerter.alerts).toHaveLength(0);
    record(500, ERROR_RATE_MIN_SAMPLE);
    expect(alerter.alerts).toHaveLength(1);
  });

  it('a failing alerter never throws into the request path', async () => {
    const failing: Alerter = { alert: () => Promise.reject(new Error('telegram down')) };
    const clock = createTestClock();
    const alerts = createApiAlerts({ alerter: failing, clock: () => clock.now(), logger: silent });
    expect(() => {
      alerts.modelPaused({ modelId: 'm', slug: 's', reason: 'admin' });
    }).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('alert hooks in the app', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeTestApp({
      extraRoutes: (app) => {
        app.get('/test/boom', () => {
          throw new Error('boom');
        });
      },
    });
  });

  afterAll(async () => {
    await t.close();
  });

  it('every finished response feeds the 5xx rate', async () => {
    const before = t.alerter.alerts.length;
    for (let i = 0; i < ERROR_RATE_MIN_SAMPLE; i += 1) {
      expect((await request(t.app).get('/test/boom')).status).toBe(500);
    }
    const fired = t.alerter.alerts.slice(before);
    expect(fired.map((a) => a.title)).toEqual(['5xx rate above 2% over 5 minutes']);
  });

  it('rejected deposits from POST /api/billing/deposits trip the hourly counter', async () => {
    const jwt = await signIn(t.app, newWallet().keypair);
    const before = t.alerter.alerts.length;
    const post = (txSignature: string) =>
      request(t.app)
        .post('/api/billing/deposits')
        .set('Authorization', bearer(jwt))
        .send({ txSignature });
    // API-09: unknown signatures are retryable and never count toward the alert
    // (4 of them, so the 10/min deposit limit leaves room for the 6 rejections).
    for (let i = 0; i < 4; i += 1) {
      expect((await post(base58Encode(randomBytes(64)))).status).toBe(202);
    }
    expect(t.alerter.alerts.slice(before)).toEqual([]);
    for (let i = 0; i < 6; i += 1) {
      const signature = base58Encode(randomBytes(64));
      t.chain.setParsedTx(
        signature,
        buildDepositTx({ signature, memo: 'not-my-ref', treasuryWallet: t.env.TREASURY_WALLET }),
      );
      expect((await post(signature)).status).toBe(422);
    }
    const fired = t.alerter.alerts.slice(before);
    expect(fired).toEqual([
      { level: 'warn', title: 'more than 5 rejected deposits in an hour', body: { count: 6 } },
    ]);
  });

  it('admin and owner pauses alert with their reason', async () => {
    const owner = await signIn(t.app, newWallet().keypair);
    const me = await request(t.app).get('/api/me').set('Authorization', bearer(owner));
    const providerId = new Types.ObjectId(MeResponseSchema.parse(me.body).id);
    const make = (slug: string) =>
      Models.create({
        providerId,
        slug,
        name: slug,
        upstream: { baseUrl: 'http://127.0.0.1:1/v1', modelName: 'm', apiKeyEnc: 'enc' },
        pricing: { inputPerMTokMicroUsdc: 1n, outputPerMTokMicroUsdc: 1n },
      });
    const byAdmin = await make('alerts-admin');
    const byOwner = await make('alerts-owner');
    const before = t.alerter.alerts.length;

    const adminRes = await request(t.app)
      .post(`/api/admin/models/${byAdmin._id.toHexString()}/pause`)
      .set('Authorization', bearer(t.env.ADMIN_TOKEN));
    expect(adminRes.status).toBe(200);
    const ownerRes = await request(t.app)
      .patch(`/api/models/${byOwner._id.toHexString()}`)
      .set('Authorization', bearer(owner))
      .send({ status: 'paused' });
    expect(ownerRes.status).toBe(200);
    // Already paused: no second alert.
    await request(t.app)
      .post(`/api/admin/models/${byAdmin._id.toHexString()}/pause`)
      .set('Authorization', bearer(t.env.ADMIN_TOKEN));

    expect(t.alerter.alerts.slice(before)).toEqual([
      {
        level: 'error',
        title: 'model paused',
        body: { modelId: byAdmin._id.toHexString(), slug: 'alerts-admin', reason: 'admin' },
      },
      {
        level: 'error',
        title: 'model paused',
        body: { modelId: byOwner._id.toHexString(), slug: 'alerts-owner', reason: 'owner' },
      },
    ]);
  });
});
