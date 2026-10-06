import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAuthFailureLimit } from '../src/middleware/authFailureLimit.js';

/** The guard, then a fake auth: keys starting with `good-` succeed. */
function harness(options: { maxKnownKeys?: number; knownKeyTtlMs?: number } = {}) {
  let now = 0;
  const limit = createAuthFailureLimit({ limit: 2, clock: () => new Date(now), ...options });
  const app = express();
  app.use(limit.guard, (req, res) => {
    if (req.get('Authorization')?.startsWith('Bearer good-')) {
      limit.recordSuccess(req);
      res.sendStatus(200);
      return;
    }
    limit.recordFailure(req);
    res.sendStatus(401);
  });
  const onError: ErrorRequestHandler = (_err, _req, res, _next) => {
    res.sendStatus(429);
  };
  app.use(onError);
  const call = async (key: string) =>
    (await request(app).get('/').set('Authorization', `Bearer ${key}`)).status;
  return { limit, call, advance: (ms: number) => (now += ms) };
}

describe('auth failure limit: recently authenticated keys (GW-08)', () => {
  it('lets a known key through a blocked IP and still refuses unknown keys', async () => {
    const { call } = harness();
    expect(await call('good-a')).toBe(200);
    expect(await call('bad')).toBe(401);
    expect(await call('bad')).toBe(401);
    expect(await call('bad')).toBe(429);
    expect(await call('good-b')).toBe(429);
    expect(await call('good-a')).toBe(200);
  });

  it('forgets a key after its TTL', async () => {
    const { call, advance } = harness({ knownKeyTtlMs: 1_000 });
    expect(await call('good-a')).toBe(200);
    advance(500);
    await call('bad');
    await call('bad');
    advance(1_000);
    expect(await call('good-a')).toBe(429);
  });

  it('keeps at most maxKnownKeys, evicting the least recently seen', async () => {
    const { limit, call } = harness({ maxKnownKeys: 3 });
    for (const key of ['good-1', 'good-2', 'good-3']) expect(await call(key)).toBe(200);
    expect(await call('good-1')).toBe(200);
    expect(await call('good-4')).toBe(200);
    expect(limit.knownKeyCount()).toBe(3);
    await call('bad');
    await call('bad');
    // `good-2` was the least recently seen, so it was evicted.
    expect(await call('good-2')).toBe(429);
    expect(await call('good-1')).toBe(200);
    expect(await call('good-4')).toBe(200);
  });
});
