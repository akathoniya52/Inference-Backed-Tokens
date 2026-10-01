import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { QueryClient } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router-dom';

import { QueryProvider } from './providers/QueryProvider';
import { routes as appRoutes, routerFuture, routerProviderFuture } from './router';

export function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

/** Query + an empty wallet context (no adapters, no auto-connect, no RPC traffic). */
export function TestProviders({
  children,
  queryClient = createTestQueryClient(),
}: {
  children: ReactNode;
  queryClient?: QueryClient;
}) {
  return (
    <QueryProvider client={queryClient}>
      <ConnectionProvider endpoint="http://127.0.0.1:8899">
        <WalletProvider wallets={[]} autoConnect={false}>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryProvider>
  );
}

interface RenderRouteOptions {
  routes?: RouteObject[];
  queryClient?: QueryClient;
}

/** Renders the app routes (or custom ones) at `path` inside a memory router. */
export function renderRoute(path: string, options: RenderRouteOptions = {}): RenderResult {
  const router = createMemoryRouter(options.routes ?? appRoutes, {
    initialEntries: [path],
    future: routerFuture,
  });
  return render(
    <TestProviders {...(options.queryClient ? { queryClient: options.queryClient } : {})}>
      <RouterProvider router={router} future={routerProviderFuture} />
    </TestProviders>,
  );
}
