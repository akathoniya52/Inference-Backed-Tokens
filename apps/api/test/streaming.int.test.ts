import { randomBytes } from 'node:crypto';
import {
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { Ledger, Models, Requests, Types, Users, adjust } from '@ibt/db';
import { createMockUpstream, type MockUpstream } from '@ibt/mock-upstream';
import { MeResponseSchema, estimateHoldMicro, microToUsdcString } from '@ibt/shared';
import { encrypt } from '@ibt/shared/node';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { countMessages } from '../src/modules/gateway/tokenCount.js';
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
const MAX_TOKENS = 64;

interface Consumer {
  key: string;
  userId: string;
}

interface RawResponse {
  status: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

/** Records every byte a mock upstream writes, per response, in order. */
function recordWrites(mock: MockUpstream): Buffer[][] {
  const writes: Buffer[][] = [];
  mock.server.prependListener('request', (_req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    writes.push(chunks);
    const write = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      chunks.push(
        typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array),
      );
      return write(chunk, ...rest);
    }) as ServerResponse['write'];
  });
  return writes;
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function connectionsOf(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.getConnections((err, n) => (err ? reject(err) : resolve(n)));
  });
}

describe('gateway: streaming pass-through', () => {
  let t: TestApp;
  let shortTotal: TestApp;
  let mock: MockUpstream;
  let slowMock: MockUpstream;
  let writes: Buffer[][];
  let server: Server;
  let shortServer: Server;

  const hello = [{ role: 'user' as const, content: 'Stream me a few words, please' }];
  const estimate = estimateHoldMicro({
    promptTokens: countMessages(hello),
    maxTokens: MAX_TOKENS,
    inPrice: IN_PRICE,
    outPrice: OUT_PRICE,
  });

  async function seedModel(
    slug: string,
    upstream: MockUpstream,
    modelName: string,
    supportsStreamUsage: boolean,
  ): Promise<void> {
    const jwt = await signIn(t.app, newWallet().keypair);
    const me = await request(t.app).get('/api/me').set('Authorization', bearer(jwt));
    if (me.status !== 200)
      throw new Error(`/api/me failed: ${me.status} ${JSON.stringify(me.body)}`);
    await Models.create({
      providerId: new Types.ObjectId(MeResponseSchema.parse(me.body).id),
      slug,
      name: slug,
      upstream: {
        baseUrl: `${upstream.url}/v1`,
        modelName,
        apiKeyEnc: encrypt('mock-key', t.env.MASTER_KEY),
        supportsStreamUsage,
      },
      pricing: { inputPerMTokMicroUsdc: IN_PRICE, outputPerMTokMicroUsdc: OUT_PRICE },
    });
  }

  async function consumer(): Promise<Consumer> {
    const jwt = await signIn(t.app, newWallet().keypair);
    const me = await request(t.app).get('/api/me').set('Authorization', bearer(jwt));
    const userId = MeResponseSchema.parse(me.body).id;
    await adjust(userId, FUNDED_MICRO, 'test credit');
    return { key: (await createApiKey(t.app, jwt)).key, userId };
  }

  function post(target: Server, key: string, body: object): Promise<RawResponse> {
    const { port } = target.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: bearer(key) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }

  function streamBody(model: string, extra: object = {}): object {
    return { model, messages: hello, max_tokens: MAX_TOKENS, stream: true, ...extra };
  }

  async function ledgerCounts(userId: string) {
    const id = new Types.ObjectId(userId);
    return {
      capture: await Ledger.countDocuments({ userId: id, type: 'capture' }),
      release: await Ledger.countDocuments({ userId: id, type: 'release' }),
    };
  }

  async function balances(userId: string) {
    const user = await Users.findById(userId).lean();
    return { balance: user?.balanceMicroUsdc, held: user?.heldMicroUsdc };
  }

  beforeAll(async () => {
    mock = await createMockUpstream({ port: 0 });
    slowMock = await createMockUpstream({ port: 0, chunkDelayMs: 300 });
    writes = recordWrites(mock);
    // Both apps read the same models, so they need the same upstream-key cipher.
    const env = { MASTER_KEY: randomBytes(32).toString('hex') };
    t = await makeTestApp({ env, timeouts: { firstByteMs: 2_000, totalMs: 10_000 } });
    shortTotal = await makeTestApp({ env, timeouts: { firstByteMs: 2_000, totalMs: 700 } });
    server = t.app;
    shortServer = shortTotal.app;
    await seedModel('st-usage', mock, 'upstream:stream', true);
    await seedModel('st-no-flag', mock, 'upstream:stream', false);
    await seedModel('st-no-done', mock, 'upstream:stream-no-done', true);
    await seedModel('st-500', mock, 'upstream:error500', true);
    await seedModel('st-slow', slowMock, 'upstream:slow-stream', true);
  });

  afterAll(async () => {
    await shortTotal.close();
    await t.close();
    await mock.close();
    await slowMock.close();
  });

  it('forwards the exact upstream bytes and captures once after [DONE]', async () => {
    const c = await consumer();
    const before = writes.length;
    const res = await post(server, c.key, streamBody('st-usage'));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-cost-usdc']).toBe(microToUsdcString(estimate));
    expect(res.headers['x-balance-usdc']).toBe(microToUsdcString(FUNDED_MICRO - estimate));
    expect(res.headers['x-discount-bps']).toBe('0');
    const requestId = res.headers['x-request-id'];
    expect(typeof requestId).toBe('string');

    expect(writes).toHaveLength(before + 1);
    const sent = Buffer.concat(writes.at(-1) ?? []);
    expect(res.body.equals(sent)).toBe(true);
    expect(res.body.toString()).toContain('data: [DONE]\n\n');

    expect(mock.calls.at(-1)?.body).toMatchObject({
      model: 'upstream:stream',
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(await ledgerCounts(c.userId)).toEqual({ capture: 1, release: 0 });
    const doc = await Requests.findOne({ requestId }).lean();
    expect(doc).toMatchObject({ status: 'success', streamed: true, usageEstimated: false });
    expect(doc?.costMicroUsdc).toBeGreaterThan(0n);
    expect(await balances(c.userId)).toEqual({
      balance: FUNDED_MICRO - (doc?.costMicroUsdc ?? 0n),
      held: 0n,
    });
  });

  it('without supportsStreamUsage sends no stream_options and counts with tiktoken', async () => {
    const c = await consumer();
    const res = await post(
      server,
      c.key,
      streamBody('st-no-flag', { stream_options: { include_usage: true } }),
    );

    expect(res.status).toBe(200);
    const upstreamBody = mock.calls.at(-1)?.body;
    expect(upstreamBody).toMatchObject({ stream: true });
    expect(upstreamBody).not.toHaveProperty('stream_options');
    expect(res.body.toString()).not.toContain('"usage"');

    const doc = await Requests.findOne({ requestId: res.headers['x-request-id'] }).lean();
    expect(doc).toMatchObject({ status: 'success', streamed: true, usageEstimated: true });
    expect(doc?.promptTokens).toBe(countMessages(hello));
    expect(doc?.completionTokens).toBeGreaterThan(0);
    expect(await ledgerCounts(c.userId)).toEqual({ capture: 1, release: 0 });
  });

  it('a stream without [DONE] is released and recorded as upstream_error', async () => {
    const c = await consumer();
    const res = await post(server, c.key, streamBody('st-no-done'));

    expect(res.status).toBe(200);
    expect(res.body.equals(Buffer.concat(writes.at(-1) ?? []))).toBe(true);
    expect(res.body.toString()).not.toContain('[DONE]');
    expect(await ledgerCounts(c.userId)).toEqual({ capture: 0, release: 1 });
    expect(await balances(c.userId)).toEqual({ balance: FUNDED_MICRO, held: 0n });
    const doc = await Requests.findOne({ requestId: res.headers['x-request-id'] }).lean();
    expect(doc).toMatchObject({ status: 'upstream_error', costMicroUsdc: 0n, streamed: true });
  });

  it('an upstream 500 is a 502 before any byte is streamed', async () => {
    const c = await consumer();
    const res = await request(t.app)
      .post('/v1/chat/completions')
      .set('Authorization', bearer(c.key))
      .send(streamBody('st-500'));

    expect(res.status).toBe(502);
    expect(errorOf(res).code).toBe('upstream_error');
    expect(await ledgerCounts(c.userId)).toEqual({ capture: 0, release: 1 });
  });

  it('a client disconnect aborts the upstream and releases the hold', async () => {
    const c = await consumer();
    const { port } = server.address() as AddressInfo;
    const requestId = `abort-${Date.now()}`;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: bearer(c.key),
            'x-request-id': requestId,
          },
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', (err) => {
        if (!req.destroyed) reject(err);
      });
      req.end(JSON.stringify(streamBody('st-slow')));
    });

    const doc = await waitFor(
      () => Requests.findOne({ requestId }).lean(),
      (row) => row !== null,
    );
    expect(doc).toMatchObject({ status: 'client_abort', costMicroUsdc: 0n, streamed: true });
    expect(await ledgerCounts(c.userId)).toEqual({ capture: 0, release: 1 });
    expect(await balances(c.userId)).toEqual({ balance: FUNDED_MICRO, held: 0n });
    expect(
      await waitFor(
        () => connectionsOf(slowMock.server),
        (n) => n === 0,
      ),
    ).toBe(0);
  });

  it('the total timeout ends a stream that already started and releases the hold', async () => {
    const c = await consumer();
    const res = await post(shortServer, c.key, streamBody('st-slow'));

    expect(res.status).toBe(200);
    expect(res.body.toString()).not.toContain('[DONE]');
    const doc = await Requests.findOne({ requestId: res.headers['x-request-id'] }).lean();
    expect(doc).toMatchObject({ status: 'timeout', costMicroUsdc: 0n, streamed: true });
    expect(await ledgerCounts(c.userId)).toEqual({ capture: 0, release: 1 });
  });
});
