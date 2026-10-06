import { createBrowserRouter, type RouteObject } from 'react-router-dom';

import { Layout } from './components/Layout';
import { RouteError } from './components/RouteError';
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
    // Catches a throw in the layout itself; page errors stop at the child below.
    errorElement: <RouteError />,
    children: [
      {
        // Pathless, so a page error renders inside the layout and the nav stays usable.
        errorElement: <RouteError />,
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
    ],
  },
];

export function createAppRouter(): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(routes);
}
