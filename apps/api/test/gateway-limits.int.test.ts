import { request as httpRequest, createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  Ledger,
  Models,
  Requests,
  Types,
  Users,
  adjust,
  capture,
  expireHolds,
  findDueCaptures,
  release,
} from '@ibt/db';
import { MeResponseSchema } from '@ibt/shared';
import { encrypt } from '@ibt/shared/node';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MAX_UPSTREAM_BODY_BYTES } from '../src/modules/gateway/completions.js';
import { CAPTURE_ATTEMPTS } from '../src/modules/gateway/stream.js';
import {
  bearer,
  createApiKey,
  errorOf,
  makeTestApp,
  newWallet,
  signIn,
  type TestApp,
} from './helpers.js';

const FUNDED_MICRO = 10_000_000n;

function chunk(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'raw',
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`;
}

/** An upstream whose behaviour is picked by the upstream model name. */
function rawUpstream(): Server {
  return createServer((req, res: ServerResponse) => {
    let raw = '';
    req.on('data', (part: Buffer) => (raw += part.toString()));
    req.on('end', () => {
      const { model } = JSON.parse(raw) as { model: string };
      if (model === 'huge-json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        const block = 'x'.repeat(1024 * 1024);
        res.write(`{"id":"c1","object":"chat.completion","created":1,"model":"raw","pad":"`);
        for (let i = 0; i <= MAX_UPSTREAM_BODY_BYTES / block.length; i += 1) res.write(block);
        res.end('"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (model === 'error-event') {
        res.write(chunk({ content: 'partial' }));
        res.write('event: error\r\ndata: {"error":{"message":"overloaded"}}\r\n\r\n');
        // Never ends on its own: the gateway must stop on the error frame.
        return;
      }
      if (model === 'reasoning-hang') {
        res.write(chunk({ role: 'assistant' }));
        res.write(chunk({ reasoning_content: 'Let me think about this carefully. '.repeat(20) }));
        return;
      }
      res.write(chunk({ content: 'Hello there' }));
      res.end('data: [DONE]\n\n');
    });
  });
}

describe('gateway: upstream limits, billing edge cases', () => {
  let t: TestApp;
  let upstream: Server;
  const hello = [{ role: 'user' as const, content: 'Hi' }];
  const mint = newWallet().wallet;

  async function userIdOf(jwt: string): Promise<string> {
    const me = await request(t.app).get('/api/me').set('Authorization', bearer(jwt));
    return MeResponseSchema.parse(me.body).id;
  }

  async function seedModel(slug: string, token?: { status: 'curve'; mint: string }) {
    const providerId = await userIdOf(await signIn(t.app, newWallet().keypair));
    const { port } = upstream.address() as AddressInfo;
    await Models.create({
      providerId: new Types.ObjectId(providerId),
      slug,
      name: slug,
      upstream: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelName: slug,
        apiKeyEnc: encrypt('raw-key', t.env.MASTER_KEY),
      },
      pricing: { inputPerMTokMicroUsdc: 1_000_000n, outputPerMTokMicroUsdc: 2_000_000n },
      ...(token ? { token } : {}),
    });
  }

  async function consumer() {
    const jwt = await signIn(t.app, newWallet().keypair);
    const userId = await userIdOf(jwt);
    await adjust(userId, FUNDED_MICRO, 'test credit');
    const { key } = await createApiKey(t.app, jwt);
    return { key, userId: new Types.ObjectId(userId) };
  }

  async function holdsOf(userId: Types.ObjectId) {
    return Ledger.find({ userId, type: { $in: ['hold', 'capture', 'release'] } })
      .select({ type: 1, status: 1 })
      .lean();
  }

  async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    for (let i = 0; i < 100; i += 1) {
      const value = await read();
      if (done(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return read();
  }

  beforeAll(async () => {
    upstream = rawUpstream();
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t = await makeTestApp({ timeouts: { firstByteMs: 5_000, totalMs: 20_000 } });
    for (const slug of ['huge-json', 'error-event', 'reasoning-hang', 'ok-stream']) {
      await seedModel(slug);
    }
    await seedModel('discounted', { status: 'curve', mint });
  });

  afterAll(async () => {
    await t.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('an upstream body over the cap is a 502 and releases the hold (GW-04)', async () => {
    const c = await consumer();
    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('Authorization', bearer(c.key))
      .send({ model: 'huge-json', messages: hello });
    expect(res.status).toBe(502);
    expect(errorOf(res).code).toBe('upstream_error');
    expect((await holdsOf(c.userId)).map((row) => row.type).sort()).toEqual(['hold', 'release']);
  });

  it('an `event: error` frame ends the stream; delivered output is billed (GW-12)', async () => {
    const c = await consumer();
    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('Authorization', bearer(c.key))
      .send({ model: 'error-event', messages: hello, stream: true });
    expect(res.status).toBe(200);
    expect(res.text).toContain('event: error');
    const doc = await Requests.findOne({ userId: c.userId }).lean();
    expect(doc).toMatchObject({ status: 'upstream_error', usageEstimated: true });
    expect(doc?.costMicroUsdc).toBeGreaterThan(0n);
  });

  it('reasoning deltas are billed when the client leaves before any content (GW-01)', async () => {
    const c = await consumer();
    const { port } = t.app.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: bearer(c.key) },
        },
        (res) => {
          let received = '';
          res.on('data', (part: Buffer) => {
            received += part.toString();
            if (received.includes('carefully')) {
              req.destroy();
              resolve();
            }
          });
        },
      );
      req.on('error', (err) => {
        if (!req.destroyed) reject(err);
      });
      req.end(JSON.stringify({ model: 'reasoning-hang', messages: hello, stream: true }));
    });
    const doc = await waitFor(
      () => Requests.findOne({ userId: c.userId }).lean(),
      (row) => row !== null,
    );
    expect(doc).toMatchObject({ status: 'client_abort', usageEstimated: true });
    expect(doc?.completionTokens).toBeGreaterThan(0);
    expect(doc?.costMicroUsdc).toBeGreaterThan(0n);
  });

  it('a client gone before the stream starts is noticed at once (GW-03)', async () => {
    const c = await consumer();
    const { port } = t.app.address() as AddressInfo;
    let clientGone: () => void = () => undefined;
    const gone = new Promise<void>((resolve) => (clientGone = resolve));
    // The discount lookup stalls until the client has left.
    const balance = vi.spyOn(t.chain, 'tokenBalance').mockImplementationOnce(async () => {
      await gone;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 0n;
    });
    const started = Date.now();
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bearer(c.key) },
    });
    req.on('error', () => undefined);
    req.end(JSON.stringify({ model: 'discounted', messages: hello, stream: true }));
    await waitFor(
      () => Promise.resolve(balance.mock.calls.length),
      (calls) => calls > 0,
    );
    req.destroy();
    clientGone();

    const doc = await waitFor(
      () => Requests.findOne({ userId: c.userId }).lean(),
      (row) => row !== null,
    );
    balance.mockRestore();
    expect(doc).toMatchObject({ status: 'client_abort', costMicroUsdc: 0n });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await holdsOf(c.userId)).map((row) => row.type).sort()).toEqual(['hold', 'release']);
  });

  it('a failed capture after a delivered stream retries, then leaves the hold open (GW-12)', async () => {
    const c = await consumer();
    const original = Ledger.findOneAndUpdate.bind(Ledger);
    const isCapture = (filter: unknown, update: unknown) =>
      JSON.stringify(filter).includes('"status":"open"') &&
      JSON.stringify(update).includes('"captured"');
    const spy = vi
      .spyOn(Ledger, 'findOneAndUpdate')
      .mockImplementation((...args: Parameters<typeof Ledger.findOneAndUpdate>) =>
        isCapture(args[0], args[1])
          ? (Promise.reject(new Error('write conflict')) as unknown as ReturnType<
              typeof Ledger.findOneAndUpdate
            >)
          : original(...args),
      );
    const alertsBefore = t.alerter.alerts.length;
    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('Authorization', bearer(c.key))
      .send({ model: 'ok-stream', messages: hello, stream: true });
    const attempts = spy.mock.calls.filter(([filter, update]) => isCapture(filter, update)).length;
    spy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.text).toContain('Hello there');
    expect(attempts).toBeGreaterThanOrEqual(CAPTURE_ATTEMPTS);
    // Never released as free: the open hold waits for reconciliation, with an alert.
    expect(await holdsOf(c.userId)).toEqual([
      expect.objectContaining({ type: 'hold', status: 'open' }),
    ]);
    expect(t.alerter.alerts.slice(alertsBefore).map((alert) => alert.title)).toContain(
      'streamed call delivered but not captured',
    );

    // GW-12: the cost is due on the hold; release refuses it and expiry captures it once.
    const holdRow = await Ledger.findOne({ userId: c.userId, type: 'hold' }).lean();
    if (!holdRow) throw new Error('no hold');
    const due = holdRow.captureDueMicroUsdc ?? 0n;
    expect(due).toBeGreaterThan(0n);
    expect((await release(holdRow._id)).released).toBe(false);
    const later = new Date(Date.now() + 60 * 60 * 1000);
    await expireHolds(later);
    expect((await Ledger.findById(holdRow._id).lean())?.status).toBe('open');
    const dueCapture = (await findDueCaptures(later)).find((row) => row.holdId.equals(holdRow._id));
    expect(dueCapture).toMatchObject({ costMicro: due, request: { status: 'success' } });
    if (!dueCapture) throw new Error('no due capture');
    await capture(dueCapture.holdId, dueCapture.costMicro, dueCapture.request);
    expect(
      (await capture(dueCapture.holdId, dueCapture.costMicro, dueCapture.request)).alreadyCaptured,
    ).toBe(true);
    expect((await holdsOf(c.userId)).map((row) => row.type).sort()).toEqual(['capture', 'hold']);
    const user = await Users.findById(c.userId).lean();
    expect(user).toMatchObject({ balanceMicroUsdc: FUNDED_MICRO - due, heldMicroUsdc: 0n });
    expect(await Requests.findOne({ userId: c.userId }).lean()).toMatchObject({
      costMicroUsdc: due,
      streamed: true,
    });
  });
});
