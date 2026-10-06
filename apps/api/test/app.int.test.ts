import { AppError } from '@ibt/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { errorOf, makeTestApp, type TestApp } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('app factory', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeTestApp({
      extraRoutes(app) {
        app.get('/__test/ip', (req, res) => {
          res.json({ ip: req.ip });
        });
        app.get('/__test/boom', () => {
          throw new Error('boom with secret detail');
        });
        app.get('/__test/async-boom', async () => {
          await Promise.resolve();
          throw new Error('async boom');
        });
        app.get('/__test/internal-detail', () => {
          throw new AppError('internal', { message: 'hold 65f0c0ffee is expired' });
        });
        app.get('/__test/app-error', () => {
          throw new AppError('forbidden', { message: 'nope' });
        });
        app.post('/__test/echo', (req, res) => {
          res.json({ body: req.body as unknown });
        });
      },
    });
  });

  afterAll(async () => {
    await t.close();
  });

  it('GET /healthz returns ok with a generated X-Request-Id', async () => {
    const res = await request(t.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.get('x-request-id')).toMatch(UUID);
  });

  it('echoes a supplied X-Request-Id', async () => {
    const res = await request(t.app).get('/healthz').set('X-Request-Id', 'req-abc_123');
    expect(res.get('x-request-id')).toBe('req-abc_123');
  });

  it('replaces a malformed X-Request-Id', async () => {
    const res = await request(t.app).get('/healthz').set('X-Request-Id', 'bad id <script>');
    expect(res.get('x-request-id')).toMatch(UUID);
  });

  it('GET /readyz pings Mongo and the chain', async () => {
    const res = await request(t.app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, mongo: true, chain: true });
  });

  it('GET /readyz shares one probe for 5 s, then probes again', async () => {
    t.clock.advance(5_000);
    expect((await request(t.app).get('/readyz')).status).toBe(200);
    const ping = vi.spyOn(t.chain, 'ping').mockResolvedValue(false);
    try {
      t.clock.advance(4_999);
      expect((await request(t.app).get('/readyz')).status).toBe(200);
      expect(ping).not.toHaveBeenCalled();

      t.clock.advance(1);
      const [down, concurrent] = await Promise.all([
        request(t.app).get('/readyz'),
        request(t.app).get('/readyz'),
      ]);
      expect(down.status).toBe(503);
      expect(down.body).toEqual({ ok: false, mongo: true, chain: false });
      expect(concurrent.body).toEqual(down.body);
      expect(ping).toHaveBeenCalledTimes(1);
    } finally {
      ping.mockRestore();
    }
  });

  it('unknown routes return a 404 envelope', async () => {
    const res = await request(t.app).get('/nope');
    expect(res.status).toBe(404);
    expect(errorOf(res)).toEqual({
      code: 'not_found',
      message: 'route not found',
      requestId: res.get('x-request-id'),
    });
  });

  it.each(['/__test/boom', '/__test/async-boom', '/__test/internal-detail'])(
    '%s returns 500 without leaking',
    async (path) => {
      const res = await request(t.app).get(path);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: { code: 'internal', message: 'internal error', requestId: res.get('x-request-id') },
      });
      // API-15: a 5xx AppError's own message (ids, state) stays in the logs.
      expect(res.text).not.toMatch(/boom|stack|\bat \w|65f0c0ffee/);
    },
  );

  it('maps AppError to its envelope', async () => {
    const res = await request(t.app).get('/__test/app-error');
    expect(res.status).toBe(403);
    expect(errorOf(res)).toMatchObject({ code: 'forbidden', message: 'nope' });
  });

  it('malformed JSON is a 400 invalid_request', async () => {
    const res = await request(t.app)
      .post('/__test/echo')
      .set('Content-Type', 'application/json')
      .send('{"a":');
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('invalid_request');
  });

  it('bodies over 1 MB are rejected', async () => {
    const res = await request(t.app)
      .post('/__test/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ a: 'x'.repeat(1024 * 1024) }));
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('invalid_request');
  });

  it('honours X-Forwarded-For for req.ip (trust proxy 1)', async () => {
    const res = await request(t.app).get('/__test/ip').set('X-Forwarded-For', '203.0.113.7');
    expect(res.body).toEqual({ ip: '203.0.113.7' });
  });

  it('sets helmet headers and restricts CORS to WEB_ORIGIN', async () => {
    const ok = await request(t.app).get('/healthz').set('Origin', t.env.WEB_ORIGIN);
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['access-control-allow-origin']).toBe(t.env.WEB_ORIGIN);
    const other = await request(t.app).get('/healthz').set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
