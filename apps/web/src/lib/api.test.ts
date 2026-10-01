import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiFetch } from './api';
import { clearToken, setToken } from './auth';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  clearToken();
});

describe('apiFetch', () => {
  it('prefixes VITE_API_URL and parses JSON', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));
    await expect(apiFetch<{ items: [] }>('/api/models')).resolves.toEqual({ items: [] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://api.test/api/models');
  });

  it('attaches the in-memory JWT only when one is set', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, {})));
    await apiFetch('/api/me');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBeNull();

    setToken('jwt-123');
    await apiFetch('/api/me', { method: 'POST', body: '{}' });
    const headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer jwt-123');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('throws ApiError from the error envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(402, {
        error: { code: 'insufficient_credits', message: 'low balance', requestId: 'req-1' },
      }),
    );
    const error = await apiFetch('/v1/chat/completions').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'insufficient_credits',
      message: 'low balance',
      requestId: 'req-1',
      status: 402,
    });
  });

  it('falls back to a generic error for non-envelope bodies', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>bad gateway</html>', { status: 502, headers: { 'x-request-id': 'r2' } }),
    );
    await expect(apiFetch('/api/models')).rejects.toMatchObject({
      code: 'http_error',
      requestId: 'r2',
      status: 502,
    });
  });

  it('maps network failures to status 0', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(apiFetch('/api/models')).rejects.toMatchObject({
      code: 'network_error',
      status: 0,
    });
  });

  it('resolves undefined for 204', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(apiFetch('/api/keys/1', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});
