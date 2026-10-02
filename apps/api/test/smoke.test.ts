import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestApp, type TestApp } from './helpers.js';

describe('@ibt/api', () => {
  let t: TestApp;
  let baseUrl = '';

  beforeAll(async () => {
    t = await makeTestApp();
    const { port } = t.app.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await t.close();
  });

  it('GET /healthz returns {"ok":true}', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
