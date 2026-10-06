import { afterEach, describe, expect, it, vi } from 'vitest';

import { SELF_PING_INTERVAL_MS, startSelfPing, type SelfPingFetch } from '../src/node/index.js';

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

describe('startSelfPing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['https://host.test/api', undefined, 'https://host.test/api/healthz'],
    ['https://host.test/api/', undefined, 'https://host.test/api/healthz'],
    ['https://host.test', undefined, 'https://host.test/healthz'],
    ['https://host.test/api', 'health/live', 'https://host.test/api/health/live'],
  ])('keeps the path of base %s (DB-08)', async (baseUrl, path, expected) => {
    const fetch = vi.fn<SelfPingFetch>().mockResolvedValue({ ok: true, status: 200 });
    const selfPing = startSelfPing({ baseUrl, path, logger: fakeLogger(), fetch });
    await selfPing.ping();
    selfPing.stop();
    expect(fetch.mock.calls[0]?.[0]).toBe(expected);
  });

  it('does nothing without a base URL', async () => {
    const fetch = vi.fn<SelfPingFetch>();
    const logger = fakeLogger();
    const selfPing = startSelfPing({ baseUrl: undefined, logger, fetch });
    await selfPing.ping();
    selfPing.stop();
    expect(fetch).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('pings the health path every interval until stopped', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<SelfPingFetch>().mockResolvedValue({ ok: true, status: 200 });
    const selfPing = startSelfPing({
      baseUrl: 'https://ibt-api.onrender.com',
      logger: fakeLogger(),
      fetch,
    });

    await vi.advanceTimersByTimeAsync(SELF_PING_INTERVAL_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://ibt-api.onrender.com/healthz');

    selfPing.stop();
    await vi.advanceTimersByTimeAsync(SELF_PING_INTERVAL_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('logs a failed or non-2xx ping instead of throwing', async () => {
    const logger = fakeLogger();
    const fetch = vi
      .fn<SelfPingFetch>()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const selfPing = startSelfPing({ baseUrl: 'https://keeper.example', logger, fetch });

    await selfPing.ping();
    await selfPing.ping();
    selfPing.stop();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ status: 503 });
  });
});
