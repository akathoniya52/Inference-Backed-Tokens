import {
  ListModelsResponseSchema,
  MAX_PAGE_LIMIT,
  ModelSchema,
  SettlementsResponseSchema,
  TokenSnapshotsResponseSchema,
  TokenStateResponseSchema,
  type Model,
} from '@ibt/shared';
import { skipToken, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { apiFetch } from './api';
import { queryKeys } from './queryKeys';

// Public read queries for Explore and the token page (spec L502). Keys stay
// local so they cannot collide with the shapes cached under `queryKeys`.

export const TOKEN_STATE_REFETCH_MS = 10_000;
export const SETTLEMENTS_REFETCH_MS = 60_000;
/** Matches the keeper's pool poll interval, so each refetch can bring one new point. */
export const SNAPSHOTS_REFETCH_MS = 15_000;
export const MODELS_PAGE_LIMIT = 24;

export const publicQueryKeys = {
  models: () => ['models', 'list'] as const,
  model: (slug: string) => ['model', slug] as const,
  tokenState: (mint: string) => ['tokenState', mint] as const,
  settlements: (mint: string) => ['settlements', mint] as const,
  priceSnapshots: (mint: string) => ['priceSnapshots', mint] as const,
};

function pageQuery(cursor: string | null, limit?: number): string {
  const params = new URLSearchParams();
  if (cursor !== null) params.set('cursor', cursor);
  if (limit !== undefined) params.set('limit', String(limit));
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export function useModels() {
  return useInfiniteQuery({
    queryKey: publicQueryKeys.models(),
    queryFn: async ({ pageParam, signal }) =>
      ListModelsResponseSchema.parse(
        await apiFetch(`/api/models${pageQuery(pageParam, MODELS_PAGE_LIMIT)}`, { signal }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

export function useModel(slug: string) {
  return useQuery({
    queryKey: publicQueryKeys.model(slug),
    queryFn: async ({ signal }) =>
      ModelSchema.parse(await apiFetch(`/api/models/${encodeURIComponent(slug)}`, { signal })),
  });
}

export function useTokenState(mint: string | null) {
  return useQuery({
    queryKey: publicQueryKeys.tokenState(mint ?? ''),
    queryFn:
      mint === null
        ? skipToken
        : async ({ signal }) =>
            TokenStateResponseSchema.parse(
              await apiFetch(`/api/tokens/${encodeURIComponent(mint)}/state`, { signal }),
            ),
    refetchInterval: TOKEN_STATE_REFETCH_MS,
  });
}

export function useSettlements(mint: string | null) {
  return useInfiniteQuery({
    queryKey: publicQueryKeys.settlements(mint ?? ''),
    queryFn:
      mint === null
        ? skipToken
        : async ({ pageParam, signal }) =>
            SettlementsResponseSchema.parse(
              await apiFetch(
                `/api/tokens/${encodeURIComponent(mint)}/settlements${pageQuery(pageParam)}`,
                { signal },
              ),
            ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    refetchInterval: SETTLEMENTS_REFETCH_MS,
  });
}

export function usePriceSnapshots(mint: string | null) {
  return useQuery({
    queryKey: publicQueryKeys.priceSnapshots(mint ?? ''),
    queryFn:
      mint === null
        ? skipToken
        : async ({ signal }) =>
            TokenSnapshotsResponseSchema.parse(
              await apiFetch(`/api/tokens/${encodeURIComponent(mint)}/snapshots`, { signal }),
            ),
    refetchInterval: SNAPSHOTS_REFETCH_MS,
  });
}

/** Registered, but its token never went live (or its launch was never confirmed). */
export function isUnlaunched(model: Model): boolean {
  return model.token.status === 'none' || model.token.status === 'pending';
}

const PROVIDER_PAGE_LIMIT = MAX_PAGE_LIMIT;
/** 50 pages of 100: far past any real registry, short of an endless loop. */
export const MAX_PROVIDER_PAGES = 50;

/**
 * Every public model whose provider is `wallet`. The registry lists active and
 * paused models, so a paused model stays visible to its owner. `GET
 * /api/models` takes only `cursor`/`limit` (no provider filter), so this pages
 * through the registry, stopping at `MAX_PROVIDER_PAGES` or when the cursor
 * stops advancing.
 */
export function useProviderModels(wallet: string | null) {
  return useQuery({
    queryKey: queryKeys.providerModels(wallet),
    queryFn:
      wallet === null
        ? skipToken
        : async ({ signal }) => {
            const owned: Model[] = [];
            const seen = new Set<string>();
            let cursor: string | null = null;
            for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
              const { items, nextCursor } = ListModelsResponseSchema.parse(
                await apiFetch(`/api/models${pageQuery(cursor, PROVIDER_PAGE_LIMIT)}`, { signal }),
              );
              owned.push(...items.filter((model) => model.providerWallet === wallet));
              if (nextCursor === null || seen.has(nextCursor)) break;
              seen.add(nextCursor);
              cursor = nextCursor;
            }
            return owned;
          },
  });
}
