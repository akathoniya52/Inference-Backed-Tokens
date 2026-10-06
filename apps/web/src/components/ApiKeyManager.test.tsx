import type { ApiKey } from '@ibt/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearToken, setToken } from '../lib/auth';
import { TestProviders } from '../test-utils';
import { ApiKeyManager } from './ApiKeyManager';

const fetchMock = vi.fn<typeof fetch>();
const FULL_KEY = 'ibt_3f9c0ffee5ecret5ecret5ecret5ecret';

function apiKey(n: number, overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: `66f1a2b3c4d5e6f7a8b9c0${String(n).padStart(2, '0')}`,
    name: `key-${n}`,
    prefix: `ibt_3f9c0${n}`,
    status: 'active',
    dailyCapUsdc: '50.000000',
    lastUsedAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Route = (url: URL, init: RequestInit | undefined) => Response | undefined;
let routes: Route[] = [];

function renderManager() {
  return render(
    <TestProviders>
      <ApiKeyManager />
    </TestProviders>,
  );
}

beforeEach(() => {
  setToken('jwt', 'wallet-1');
  routes = [];
  fetchMock.mockImplementation((input, init) => {
    const url = new URL(input as string);
    for (const route of routes) {
      const response = route(url, init);
      if (response) return Promise.resolve(response);
    }
    return Promise.resolve(json(404, { error: { code: 'not_found', message: url.pathname } }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  clearToken();
});

describe('ApiKeyManager', () => {
  it('shows loading, then the empty state', async () => {
    routes.push((url) =>
      url.pathname === '/api/keys' ? json(200, { items: [], nextCursor: null }) : undefined,
    );
    renderManager();
    expect(screen.getByText('Loading keys…')).toBeTruthy();
    expect(await screen.findByText(/No keys yet/)).toBeTruthy();
  });

  it('shows a load error', async () => {
    routes.push(() => json(500, { error: { code: 'internal', message: 'boom' } }));
    renderManager();
    expect((await screen.findByRole('alert')).textContent).toMatch(/boom/);
  });

  it('pages through keys with the cursor', async () => {
    routes.push((url) => {
      if (url.pathname !== '/api/keys') return undefined;
      return url.searchParams.get('cursor') === 'c2'
        ? json(200, { items: [apiKey(3)], nextCursor: null })
        : json(200, { items: [apiKey(1), apiKey(2)], nextCursor: 'c2' });
    });
    renderManager();
    expect(await screen.findByText('key-2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('key-3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.get('limit')).toBe('20');
  });

  it('shows the full key exactly once after creating it', async () => {
    let created = false;
    routes.push((url, init) => {
      if (url.pathname !== '/api/keys') return undefined;
      if (init?.method === 'POST') {
        created = true;
        return json(201, { ...apiKey(1, { name: 'production' }), key: FULL_KEY });
      }
      return json(200, {
        items: created ? [apiKey(1, { name: 'production' })] : [],
        nextCursor: null,
      });
    });
    renderManager();
    await screen.findByText(/No keys yet/);

    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    expect(screen.getByText(/Name the key/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'production' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('full-api-key').textContent).toBe(FULL_KEY);
    expect(screen.getAllByText(FULL_KEY)).toHaveLength(1);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[1]?.body).toBe(JSON.stringify({ name: 'production' }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'I have saved it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('production')).toBeTruthy();
    expect(screen.queryByText(FULL_KEY)).toBeNull();
    expect(document.body.textContent).not.toContain(FULL_KEY);
  });

  it('traps focus, warns before an accidental close and before leaving the page', async () => {
    routes.push((url, init) => {
      if (url.pathname !== '/api/keys') return undefined;
      if (init?.method === 'POST') {
        return json(201, { ...apiKey(1, { name: 'production' }), key: FULL_KEY });
      }
      return json(200, { items: [], nextCursor: null });
    });
    renderManager();
    await screen.findByText(/No keys yet/);
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'production' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    const dialog = await screen.findByRole('dialog');
    const copyButton = within(dialog).getByRole('button', { name: 'Copy key' });
    const done = within(dialog).getByRole('button', { name: 'I have saved it' });
    expect(document.activeElement).toBe(done);
    fireEvent.keyDown(done, { key: 'Tab' });
    expect(document.activeElement).toBe(copyButton);
    fireEvent.keyDown(copyButton, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(done);

    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(within(dialog).getByText(/Close without saving\?/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it open' }));
    expect(within(dialog).getByTestId('full-api-key').textContent).toBe(FULL_KEY);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close anyway' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('revokes a key after confirmation', async () => {
    let revoked = false;
    routes.push((url, init) => {
      if (url.pathname === '/api/keys/66f1a2b3c4d5e6f7a8b9c001' && init?.method === 'DELETE') {
        revoked = true;
        return json(200, apiKey(1, { status: 'revoked' }));
      }
      if (url.pathname === '/api/keys') {
        return json(200, {
          items: [apiKey(1, revoked ? { status: 'revoked' } : {})],
          nextCursor: null,
        });
      }
      return undefined;
    });
    renderManager();
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke key-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => expect(screen.getByText('revoked')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull();
  });
});
