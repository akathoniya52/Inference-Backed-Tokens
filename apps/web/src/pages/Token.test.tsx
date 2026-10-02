import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { chartMock } from '../fixtures/lightweightCharts';
import { mockApi } from '../fixtures/mockApi';
import {
  CURVE_MINT,
  curveModel,
  GRADUATED_DAMM_POOL,
  GRADUATED_MIGRATION_SIG,
  GRADUATED_MINT,
  graduatedModel,
  unlaunchedModel,
} from '../fixtures/models';
import {
  curveSettlementsPage,
  curveSnapshots,
  curveTokenState,
  emptySettlements,
  graduatedTokenState,
} from '../fixtures/tokens';
import { routerFuture, routerProviderFuture } from '../router';
import { renderRoute, TestProviders } from '../test-utils';
import { TokenPage } from './TokenPage';

vi.mock('lightweight-charts', () => import('../fixtures/lightweightCharts'));

afterEach(() => {
  vi.restoreAllMocks();
});

function mockCurve() {
  return mockApi([
    { path: `/api/models/${curveModel.slug}`, body: curveModel },
    { path: `/api/tokens/${CURVE_MINT}/state`, body: curveTokenState },
    { path: `/api/tokens/${CURVE_MINT}/settlements`, body: curveSettlementsPage },
    { path: `/api/tokens/${CURVE_MINT}/snapshots`, body: curveSnapshots },
  ]);
}

describe('TokenPage', () => {
  it('renders the header, curve progress, stats and settlement ledger', async () => {
    mockCurve();
    renderRoute(`/t/${curveModel.slug}`);

    expect(
      screen.getByRole('heading', { level: 1, name: `Token ${curveModel.slug}` }),
    ).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 1, name: curveModel.name })).toBeTruthy();
    expect(screen.getByText('$LLAMA8')).toBeTruthy();
    expect(screen.getByText('On curve')).toBeTruthy();

    const mint = screen.getByRole('link', { name: 'Mint 4h5Y…zqHx on Solscan' });
    expect(mint.getAttribute('href')).toBe(
      `https://solscan.io/account/${CURVE_MINT}?cluster=devnet`,
    );
    expect(screen.getByRole('button', { name: 'Copy mint address' })).toBeTruthy();

    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    const chart = await screen.findByRole('figure', { name: 'Token price chart' });
    expect(chart.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chartMock.setData).toHaveBeenCalled();
    expect(screen.getByText('Requests 24h', { selector: 'dt' })).toBeTruthy();
    expect(await screen.findByText('2 Oct 2026, 13:00–14:00 UTC')).toBeTruthy();
    expect(document.querySelector('[data-slot="trade-panel"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="claim-fees"]')).not.toBeNull();
  });

  it('copies the mint address', async () => {
    mockCurve();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderRoute(`/t/${curveModel.slug}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Copy mint address' }));
    expect(writeText).toHaveBeenCalledWith(CURVE_MINT);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('shows the DAMM v2 pool and migration for a graduated token', async () => {
    mockApi([
      { path: `/api/models/${graduatedModel.slug}`, body: graduatedModel },
      { path: `/api/tokens/${GRADUATED_MINT}/state`, body: graduatedTokenState },
      { path: `/api/tokens/${GRADUATED_MINT}/settlements`, body: emptySettlements },
    ]);
    renderRoute(`/t/${graduatedModel.slug}`);

    const panel = await screen.findByRole('region', { name: 'Graduated' });
    expect(
      within(panel).getByRole('link', { name: 'DAMM v2 pool on Solscan' }).getAttribute('href'),
    ).toBe(`https://solscan.io/account/${GRADUATED_DAMM_POOL}?cluster=devnet`);
    expect(
      within(panel).getByRole('link', { name: 'Migration transaction' }).getAttribute('href'),
    ).toBe(`https://solscan.io/tx/${GRADUATED_MIGRATION_SIG}?cluster=devnet`);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(await screen.findByText('No settlements yet')).toBeTruthy();
  });

  it('explains a model without a token and skips token requests', async () => {
    const spy = mockApi([{ path: `/api/models/${unlaunchedModel.slug}`, body: unlaunchedModel }]);
    renderRoute(`/t/${unlaunchedModel.slug}`);

    expect(await screen.findByText('No token launched yet')).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('shows not found for an unknown slug', async () => {
    mockApi([
      {
        path: '/api/models/missing',
        status: 404,
        body: { error: { code: 'model_not_found', message: 'model not found', requestId: 'r1' } },
      },
    ]);
    renderRoute('/t/missing');
    expect(await screen.findByRole('heading', { level: 1, name: 'Model not found' })).toBeTruthy();
  });

  it('mounts the trade panel and claim fees slots', async () => {
    mockCurve();
    const router = createMemoryRouter(
      [
        {
          path: '/t/:slug',
          element: (
            <TokenPage
              tradePanel={({ model }) => <p>Trade {model.slug}</p>}
              claimFees={({ model }) => <p>Claim {model.slug}</p>}
            />
          ),
        },
      ],
      { initialEntries: [`/t/${curveModel.slug}`], future: routerFuture },
    );
    render(
      <TestProviders>
        <RouterProvider router={router} future={routerProviderFuture} />
      </TestProviders>,
    );
    await waitFor(() => {
      expect(screen.getByText(`Trade ${curveModel.slug}`)).toBeTruthy();
    });
    expect(screen.getByText(`Claim ${curveModel.slug}`)).toBeTruthy();
  });
});
