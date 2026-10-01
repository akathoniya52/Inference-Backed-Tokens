import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 10_000, retry: 1 },
    },
  });
}

interface QueryProviderProps {
  children: ReactNode;
  /** Injected by tests; the app creates its own client once. */
  client?: QueryClient;
}

export function QueryProvider({ children, client }: QueryProviderProps) {
  const [queryClient] = useState(() => client ?? createQueryClient());
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
