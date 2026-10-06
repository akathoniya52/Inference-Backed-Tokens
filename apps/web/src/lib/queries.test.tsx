import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { curveModel, graduatedModel, unlaunchedModel } from '../fixtures/models';
import { mockApi } from '../fixtures/mockApi';
import { TestProviders } from '../test-utils';
import { MAX_PROVIDER_PAGES, useModel, useProviderModels } from './queries';

function wrapper({ children }: { children: ReactNode }) {
  return <TestProviders>{children}</TestProviders>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useProviderModels (WEB-12)', () => {
  it("keeps only the wallet's models across pages", async () => {
    const fetchSpy = mockApi([
      {
        path: '/api/models?limit=100',
        body: { items: [curveModel, graduatedModel], nextCursor: 'c1' },
      },
      {
        path: '/api/models?cursor=c1&limit=100',
        body: { items: [unlaunchedModel], nextCursor: null },
      },
    ]);
    const { result } = renderHook(() => useProviderModels(curveModel.providerWallet), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((model) => model.slug)).toEqual([
      curveModel.slug,
      unlaunchedModel.slug,
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('stops when the cursor does not advance', async () => {
    const fetchSpy = mockApi([
      { path: /^\/api\/models\?/, body: { items: [curveModel], nextCursor: 'stuck' } },
    ]);
    const { result } = renderHook(() => useProviderModels(curveModel.providerWallet), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it(`stops after ${MAX_PROVIDER_PAGES} pages`, async () => {
    let page = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      page += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], nextCursor: `c${page}` }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    const { result } = renderHook(() => useProviderModels(curveModel.providerWallet), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(MAX_PROVIDER_PAGES);
  });
});

describe('response parsing (WEB-05)', () => {
  it('rejects a model whose addresses are not public keys instead of caching it', async () => {
    mockApi([
      {
        path: `/api/models/${curveModel.slug}`,
        body: { ...curveModel, token: { ...curveModel.token, mint: 'not-a-key' } },
      },
    ]);
    const { result } = renderHook(() => useModel(curveModel.slug), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
