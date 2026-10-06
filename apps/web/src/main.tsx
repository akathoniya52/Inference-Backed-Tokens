import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import { sdkNames } from './lib/sdkSmoke';
import { QueryProvider } from './providers/QueryProvider';
import { WalletProviders } from './providers/WalletProviders';
import { createAppRouter } from './router';

import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('missing #root element');
}

// Keeps the Meteora SDK smoke import reachable (see lib/sdkSmoke.ts).
rootEl.dataset.sdk = sdkNames.join(' ');

const router = createAppRouter();

createRoot(rootEl).render(
  <StrictMode>
    <QueryProvider>
      <WalletProviders>
        <RouterProvider router={router} />
      </WalletProviders>
    </QueryProvider>
  </StrictMode>,
);
