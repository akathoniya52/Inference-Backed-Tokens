import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { Models } from '@ibt/db';
import { HealthCheckResponseSchema, OwnerModelSchema } from '@ibt/shared';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApiAlerts } from '../src/alerts.js';
import { runHealthCheck } from '../src/modules/models/health.js';
import { bearer, errorOf, makeTestApp, newWallet, signIn, type TestApp } from './helpers.js';

const UPSTREAM_KEY = 'sk-health-upstream-secret';

type Mode = 'ok' | 'error500' | 'slow' | 'malformed';

interface Upstream {
  url: string;
  mode: Mode;
  bodies: unknown[];
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** Minimal OpenAI-compatible upstream (`@ibt/mock-upstream` is not an api dependency). */
async function startUpstream(): Promise<Upstream> {
  const sockets = new Set<Socket>();
  const upstream: Upstream = { url: '', mode: 'ok', bodies: [], close: () => Promise.resolve() };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    upstream.bodies.push(await readJson(req));
    if (req.headers.authorization !== `Bearer ${UPSTREAM_KEY}`) {
      res.writeHead(401).end();
      return;
    }
    if (upstream.mode === 'error500') {
      res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
      return;
    }
    if (upstream.mode === 'slow') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (upstream.mode === 'malformed') {
      res.end('{"not":"a completion"}');
      return;
    }
    res.end(
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'up',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'p' }, finish_reason: 'length' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    );
  };
  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  upstream.url = `http://127.0.0.1:${port}/v1`;
  upstream.close = () =>
    new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  return upstream;
}

describe('model health check', () => {
  let t: TestApp;
  let upstream: Upstream;
  let owner: string;
  let modelId: string;
  const texts: string[] = [];

  async function check(jwt = owner) {
    const res = await request(t.app)
      .post(`/api/models/${modelId}/health-check`)
      .set('Authorization', bearer(jwt));
    texts.push(res.text);
    return res;
  }

  beforeAll(async () => {
    upstream = await startUpstream();
    t = await makeTestApp({ timeouts: { firstByteMs: 100, totalMs: 200 } });
    owner = await signIn(t.app, newWallet().keypair);
  });

  beforeEach(async () => {
    upstream.mode = 'ok';
    upstream.bodies.length = 0;
    const res = await request(t.app)
      .post('/api/models')
      .set('Authorization', bearer(owner))
      .send({
        slug: `health-${Math.random().toString(36).slice(2, 10)}`,
        name: 'Health',
        upstream: { baseUrl: upstream.url, modelName: 'up-model', apiKey: UPSTREAM_KEY },
        pricing: { inputPerMTokUsdc: '0.1', outputPerMTokUsdc: '0.4' },
      });
    modelId = OwnerModelSchema.parse(res.body).id;
  });

  afterAll(async () => {
    await t.close();
    await upstream.close();
  });

  it('a healthy upstream records lastOkAt and p50 latency with a max_tokens:1 call', async () => {
    await Models.updateOne({ _id: modelId }, { $set: { 'health.consecutiveFailures': 2 } });
    const res = await check();
    expect(res.status).toBe(200);
    const body = HealthCheckResponseSchema.parse(res.body);
    expect(body).toMatchObject({ ok: true, status: 'active', consecutiveFailures: 0 });
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(upstream.bodies).toEqual([
      expect.objectContaining({ model: 'up-model', max_tokens: 1, stream: false }),
    ]);

    const stored = await Models.findById(modelId).lean();
    expect(stored?.health.lastOkAt).toEqual(t.clock.now());
    expect(stored?.health.p50LatencyMs).toBe(body.latencyMs);
    expect(stored?.health.consecutiveFailures).toBe(0);
  });

  it('the third consecutive failure pauses the model and alerts once', async () => {
    upstream.mode = 'error500';
    const alertsBefore = t.alerter.alerts.length;

    const first = HealthCheckResponseSchema.parse((await check()).body);
    expect(first).toMatchObject({
      ok: false,
      latencyMs: null,
      status: 'active',
      consecutiveFailures: 1,
      error: 'upstream returned 500',
    });
    upstream.mode = 'malformed';
    const second = HealthCheckResponseSchema.parse((await check()).body);
    expect(second).toMatchObject({ consecutiveFailures: 2, status: 'active' });
    expect(second.error).toBe('upstream returned a malformed body');

    upstream.mode = 'slow';
    const started = Date.now();
    const third = HealthCheckResponseSchema.parse((await check()).body);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(third).toMatchObject({
      consecutiveFailures: 3,
      status: 'paused',
      error: 'upstream timed out',
    });
    expect((await Models.findById(modelId).lean())?.status).toBe('paused');

    const fourth = HealthCheckResponseSchema.parse((await check()).body);
    expect(fourth).toMatchObject({ consecutiveFailures: 4, status: 'paused' });

    const newAlerts = t.alerter.alerts.slice(alertsBefore);
    expect(newAlerts).toHaveLength(1);
    expect(newAlerts[0]).toMatchObject({
      level: 'error',
      body: { modelId, consecutiveFailures: 3 },
    });
    expect(JSON.stringify(newAlerts)).not.toContain(UPSTREAM_KEY);
  });

  it('runHealthCheck is reusable outside the route (G12)', async () => {
    const model = await Models.findById(modelId).lean();
    if (!model) throw new Error('model missing');
    upstream.mode = 'error500';
    const ctx = {
      env: t.env,
      chain: t.chain,
      alerter: t.alerter,
      clock: () => t.clock.now(),
      timeouts: { firstByteMs: 100, totalMs: 200 },
      logger: pino({ level: 'silent' }),
      alerts: createApiAlerts({
        alerter: t.alerter,
        clock: () => t.clock.now(),
        logger: pino({ level: 'silent' }),
      }),
    };
    const result = await runHealthCheck(ctx, model);
    expect(result).toMatchObject({ ok: false, consecutiveFailures: 1 });
  });

  it('is owner-only and 404s for unknown models', async () => {
    const stranger = await signIn(t.app, newWallet().keypair);
    const foreign = await check(stranger);
    expect(foreign.status).toBe(403);
    expect(errorOf(foreign).code).toBe('forbidden');
    expect(upstream.bodies).toHaveLength(0);

    const missing = await request(t.app)
      .post('/api/models/0123456789abcdef01234567/health-check')
      .set('Authorization', bearer(owner));
    expect(missing.status).toBe(404);
    expect((await request(t.app).post(`/api/models/${modelId}/health-check`)).status).toBe(401);
  });

  it('never returns the upstream key or its ciphertext', () => {
    expect(texts.length).toBeGreaterThan(4);
    for (const text of texts) {
      expect(text).not.toContain(UPSTREAM_KEY);
      expect(text).not.toContain('apiKeyEnc');
    }
  });
});
