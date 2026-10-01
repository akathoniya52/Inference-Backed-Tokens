import { createBrowserRouter, type RouteObject } from 'react-router-dom';

import { Layout } from './components/Layout';
import { DashboardPage } from './pages/DashboardPage';
import { DocsPage } from './pages/DocsPage';
import { ExplorePage } from './pages/ExplorePage';
import { LaunchPage } from './pages/LaunchPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProviderPage } from './pages/ProviderPage';
import { TokenPage } from './pages/TokenPage';

// Spec L477–484.
export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { index: true, element: <ExplorePage /> },
      { path: 't/:slug', element: <TokenPage /> },
      { path: 'launch', element: <LaunchPage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'provider', element: <ProviderPage /> },
      { path: 'docs', element: <DocsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

// Opt into the v7 behaviours now so the upgrade is a no-op and dev logs stay clean.
export const routerFuture = {
  v7_fetcherPersist: true,
  v7_normalizeFormMethod: true,
  v7_partialHydration: true,
  v7_relativeSplatPath: true,
  v7_skipActionErrorRevalidation: true,
} as const;

export const routerProviderFuture = { v7_startTransition: true } as const;

export function createAppRouter(): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(routes, { future: routerFuture });
}
