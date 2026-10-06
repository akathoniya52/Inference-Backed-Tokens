import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { Models } from '@ibt/db';
import { HealthCheckResponseSchema, OwnerModelSchema } from '@ibt/shared';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApiAlerts } from '../src/alerts.js';
import { createUpstreamAgent } from '../src/lib/upstreamAgent.js';
import { runAllHealthChecks } from '../src/modules/admin/service.js';
import {
  LATENCY_MAX_MODELS,
  recordLatency,
  runHealthCheck,
  trackedLatencyModels,
} from '../src/modules/models/health.js';
import { HEALTH_CHECK_LIMIT_PER_MIN } from '../src/modules/models/router.js';
import { bearer, errorOf, makeTestApp, newWallet, signIn, type TestApp } from './helpers.js';

const UPSTREAM_KEY = 'sk-health-upstream-secret';

type Mode = 'ok' | 'error500' | 'slow' | 'malformed' | 'redirect';

interface Upstream {
  url: string;
  mode: Mode;
  bodies: unknown[];
  /** Requests being handled right now, and the most at any one time. */
  inFlight: number;
  maxInFlight: number;
  /** Delay before an `ok` answer. */
  delayMs: number;
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
  const upstream: Upstream = {
    url: '',
    mode: 'ok',
    bodies: [],
    inFlight: 0,
    maxInFlight: 0,
    delayMs: 0,
    close: () => Promise.resolve(),
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    upstream.bodies.push(await readJson(req));
    if (upstream.mode === 'redirect') {
      res.writeHead(302, { location: `${upstream.url}/redirected` }).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${UPSTREAM_KEY}`) {
      res.writeHead(401).end();
      return;
    }
    if (upstream.mode === 'error500') {
      res
        .writeHead(500, { 'content-type': 'application/json' })
        .end('{"error":"boom: internal upstream detail"}');
      return;
    }
    if (upstream.mode === 'slow') return;
    upstream.inFlight += 1;
    upstream.maxInFlight = Math.max(upstream.maxInFlight, upstream.inFlight);
    if (upstream.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, upstream.delayMs));
    upstream.inFlight -= 1;
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
    expect(texts.join('\n')).not.toContain('internal upstream detail');

    // API-02: the owner cannot resume a health pause while the upstream still fails...
    expect((await Models.findById(modelId).lean())?.pausedBy).toBe('health');
    const resume = () =>
      request(t.app)
        .patch(`/api/models/${modelId}`)
        .set('Authorization', bearer(owner))
        .send({ status: 'active' });
    const refused = await resume();
    expect(refused.status).toBe(403);
    expect((await Models.findById(modelId).lean())?.status).toBe('paused');
    // ...only after a passing health check.
    upstream.mode = 'ok';
    expect(HealthCheckResponseSchema.parse((await check()).body)).toMatchObject({ ok: true });
    expect((await resume()).status).toBe(200);
    expect(await Models.findById(modelId).lean()).toMatchObject({
      status: 'active',
      pausedBy: null,
    });
  });

  it('keeps latency samples for a bounded number of models, oldest out first (API-16)', () => {
    for (let i = 0; i <= LATENCY_MAX_MODELS + 50; i += 1) recordLatency(`model-${i}`, i);
    expect(trackedLatencyModels()).toBe(LATENCY_MAX_MODELS);
    // A model checked again moves to the back and keeps its samples.
    expect(recordLatency(`model-${LATENCY_MAX_MODELS + 50}`, 0)).toBe(0);
    expect(trackedLatencyModels()).toBe(LATENCY_MAX_MODELS);
  });

  it('does not follow upstream redirects', async () => {
    upstream.mode = 'redirect';
    const body = HealthCheckResponseSchema.parse((await check()).body);
    expect(body).toMatchObject({ ok: false, error: 'upstream returned 302' });
    expect(upstream.bodies).toHaveLength(1);
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
      upstreamAgent: createUpstreamAgent({ allowPrivate: true }),
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

  it('runAllHealthChecks probes at most 4 upstreams at once', async () => {
    await Models.updateMany({ status: 'active' }, { $set: { status: 'paused' } });
    const extra = await Promise.all(
      Array.from({ length: 9 }, (_, i) =>
        request(t.app)
          .post('/api/models')
          .set('Authorization', bearer(owner))
          .send({
            slug: `health-many-${i}-${Math.random().toString(36).slice(2, 8)}`,
            name: 'Health',
            upstream: { baseUrl: upstream.url, modelName: 'up-model', apiKey: UPSTREAM_KEY },
            pricing: { inputPerMTokUsdc: '0.1', outputPerMTokUsdc: '0.4' },
          }),
      ),
    );
    expect(extra.every((res) => res.status === 201)).toBe(true);
    upstream.bodies.length = 0;
    upstream.maxInFlight = 0;
    upstream.delayMs = 20;
    const ctx = {
      env: t.env,
      chain: t.chain,
      alerter: t.alerter,
      clock: () => t.clock.now(),
      timeouts: { firstByteMs: 1000, totalMs: 2000 },
      logger: pino({ level: 'silent' }),
      alerts: createApiAlerts({
        alerter: t.alerter,
        clock: () => t.clock.now(),
        logger: pino({ level: 'silent' }),
      }),
      upstreamAgent: createUpstreamAgent({ allowPrivate: true }),
    };
    try {
      const summary = await runAllHealthChecks(ctx);
      expect(summary).toMatchObject({ checked: 9, ok: 9, failed: 0 });
      expect(upstream.bodies).toHaveLength(9);
      expect(upstream.maxInFlight).toBe(4);
    } finally {
      upstream.delayMs = 0;
    }
  });

  it(`limits a user to ${HEALTH_CHECK_LIMIT_PER_MIN} checks per minute`, async () => {
    const limited = await makeTestApp({ timeouts: { firstByteMs: 100, totalMs: 200 } });
    try {
      const provider = await signIn(limited.app, newWallet().keypair);
      const created = await request(limited.app)
        .post('/api/models')
        .set('Authorization', bearer(provider))
        .send({
          slug: `health-limit-${Math.random().toString(36).slice(2, 10)}`,
          name: 'Health',
          upstream: { baseUrl: upstream.url, modelName: 'up-model', apiKey: UPSTREAM_KEY },
          pricing: { inputPerMTokUsdc: '0.1', outputPerMTokUsdc: '0.4' },
        });
      const id = OwnerModelSchema.parse(created.body).id;
      const post = () =>
        request(limited.app)
          .post(`/api/models/${id}/health-check`)
          .set('Authorization', bearer(provider));
      for (let i = 0; i < HEALTH_CHECK_LIMIT_PER_MIN; i += 1) {
        expect((await post()).status).toBe(200);
      }
      const blocked = await post();
      expect(blocked.status).toBe(429);
      expect(errorOf(blocked).code).toBe('rate_limited');
    } finally {
      await limited.close();
    }
  });

  it('never returns the upstream key or its ciphertext', () => {
    expect(texts.length).toBeGreaterThan(4);
    for (const text of texts) {
      expect(text).not.toContain(UPSTREAM_KEY);
      expect(text).not.toContain('apiKeyEnc');
    }
  });
});

describe('model health check without ALLOW_PRIVATE_UPSTREAMS', () => {
  let t: TestApp;
  let upstream: Upstream;
  let owner: string;

  beforeAll(async () => {
    upstream = await startUpstream();
    t = await makeTestApp({
      env: { ALLOW_PRIVATE_UPSTREAMS: 'false' },
      timeouts: { firstByteMs: 500, totalMs: 1000 },
    });
    owner = await signIn(t.app, newWallet().keypair);
  });

  afterAll(async () => {
    await t.close();
    await upstream.close();
  });

  it.each([
    ['an IP literal', (url: string) => url],
    ['a host name', (url: string) => url.replace('127.0.0.1', 'localhost')],
  ])('refuses a loopback upstream given as %s without leaking why', async (_label, toUrl) => {
    upstream.bodies.length = 0;
    const created = await request(t.app)
      .post('/api/models')
      .set('Authorization', bearer(owner))
      .send({
        slug: `ssrf-${Math.random().toString(36).slice(2, 10)}`,
        name: 'SSRF',
        upstream: { baseUrl: toUrl(upstream.url), modelName: 'up-model', apiKey: UPSTREAM_KEY },
        pricing: { inputPerMTokUsdc: '0.1', outputPerMTokUsdc: '0.4' },
      });
    const id = OwnerModelSchema.parse(created.body).id;
    const res = await request(t.app)
      .post(`/api/models/${id}/health-check`)
      .set('Authorization', bearer(owner));
    expect(res.status).toBe(200);
    expect(HealthCheckResponseSchema.parse(res.body)).toMatchObject({
      ok: false,
      error: 'upstream request failed',
    });
    expect(upstream.bodies).toHaveLength(0);
  });
});
