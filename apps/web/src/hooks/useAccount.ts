import {
  CreateApiKeyResponseSchema,
  ListApiKeysResponseSchema,
  MeResponseSchema,
  RevokeApiKeyResponseSchema,
  UsageResponseSchema,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  type ListApiKeysResponse,
  type MeResponse,
  type UsageResponse,
} from '@ibt/shared';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';

import { apiFetch } from '../lib/api';
import { useSessionWallet } from './useAuth';

// Keys carry the session wallet so one wallet's data never shows for another;
// invalidating the bare prefix (e.g. `['me']`) still matches every wallet.
export const accountKeys = {
  me: (wallet: string | null) => ['me', wallet] as const,
  keys: (wallet: string | null) => ['keys', wallet] as const,
  usage: (wallet: string | null) => ['usage', wallet] as const,
};

export const API_KEYS_PAGE_SIZE = 20;

export function useMe() {
  const wallet = useSessionWallet();
  return useQuery<MeResponse>({
    queryKey: accountKeys.me(wallet),
    queryFn: async () => MeResponseSchema.parse(await apiFetch('/api/me')),
    enabled: wallet !== null,
  });
}

export function useApiKeys() {
  const wallet = useSessionWallet();
  return useInfiniteQuery<
    ListApiKeysResponse,
    Error,
    InfiniteData<ListApiKeysResponse>,
    readonly unknown[],
    string | null
  >({
    queryKey: accountKeys.keys(wallet),
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(API_KEYS_PAGE_SIZE) });
      if (pageParam) params.set('cursor', pageParam);
      return ListApiKeysResponseSchema.parse(await apiFetch(`/api/keys?${params.toString()}`));
    },
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: wallet !== null,
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation<CreateApiKeyResponse, Error, CreateApiKeyRequest>({
    mutationFn: async (body) =>
      CreateApiKeyResponseSchema.parse(
        await apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['keys'] }),
  });
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      RevokeApiKeyResponseSchema.parse(
        await apiFetch(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['keys'] }),
  });
}

export function useUsage() {
  const wallet = useSessionWallet();
  return useQuery<UsageResponse>({
    queryKey: accountKeys.usage(wallet),
    queryFn: async () => UsageResponseSchema.parse(await apiFetch('/api/billing/usage')),
    enabled: wallet !== null,
  });
}
