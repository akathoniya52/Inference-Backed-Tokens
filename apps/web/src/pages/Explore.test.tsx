import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockApi, requestedPaths } from '../fixtures/mockApi';
import {
  CURVE_MINT,
  curveModel,
  emptyModels,
  graduatedModel,
  modelsPage1,
  modelsPage2,
} from '../fixtures/models';
import { curveTokenState } from '../fixtures/tokens';
import { renderRoute } from '../test-utils';

const PAGE_1 = '/api/models?limit=24';
const PAGE_2 = '/api/models?cursor=cursor-page-2&limit=24';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExplorePage', () => {
  it('lists model cards from the registry with prices, stats and phase', async () => {
    mockApi([
      { path: PAGE_1, body: modelsPage1 },
      { path: `/api/tokens/${CURVE_MINT}/state`, body: curveTokenState },
    ]);
    renderRoute('/');

    const cards = await screen.findAllByRole('article');
    expect(cards).toHaveLength(2);

    const curveCard = within(cards[0] as HTMLElement);
    const link = curveCard.getByRole('link', { name: curveModel.name });
    expect(link.getAttribute('href')).toBe(`/t/${curveModel.slug}`);
    expect(curveCard.getByText(curveModel.slug, { exact: false })).toBeTruthy();
    expect(curveCard.getByText('$LLAMA8')).toBeTruthy();
    expect(curveCard.getByText('$0.20')).toBeTruthy();
    expect(curveCard.getByText('$0.60')).toBeTruthy();
    expect(curveCard.getByText('1,180')).toBeTruthy();
    expect(curveCard.getByText('99.2%')).toBeTruthy();
    expect(curveCard.getByText('On curve')).toBeTruthy();
    expect(curveCard.getByText('AG9c…yvbc')).toBeTruthy();

    const bar = await curveCard.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(curveCard.getByText('42%')).toBeTruthy();

    const graduatedCard = within(cards[1] as HTMLElement);
    expect(graduatedCard.getByText('Graduated')).toBeTruthy();
    expect(graduatedCard.getByText('3.215 SOL')).toBeTruthy();
    expect(graduatedCard.queryByRole('progressbar')).toBeNull();
    expect(graduatedCard.getByRole('link', { name: graduatedModel.name })).toBeTruthy();
  });

  it('loads the next page with the cursor', async () => {
    const fetchSpy = mockApi([
      { path: PAGE_1, body: modelsPage1 },
      { path: PAGE_2, body: modelsPage2 },
      { path: `/api/tokens/${CURVE_MINT}/state`, body: curveTokenState },
    ]);
    renderRoute('/');

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Mistral Small 24B')).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.getByText('No token')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(requestedPaths(fetchSpy)).toContain(PAGE_2);
  });

  it('shows an empty state', async () => {
    mockApi([{ path: PAGE_1, body: emptyModels }]);
    renderRoute('/');
    expect(await screen.findByText('No models yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'List a model' }).getAttribute('href')).toBe('/launch');
  });

  it('shows skeletons while loading', () => {
    mockApi([{ path: PAGE_1, body: modelsPage1 }]);
    renderRoute('/');
    expect(screen.getByRole('status', { name: 'Loading models' })).toBeTruthy();
  });

  it('shows an error with a retry that refetches', async () => {
    const fetchSpy = mockApi([
      {
        path: PAGE_1,
        status: 500,
        body: { error: { code: 'internal', message: 'internal error', requestId: 'req_1' } },
      },
    ]);
    renderRoute('/');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Could not load models')).toBeTruthy();
    expect(within(alert).getByText(/internal error · request req_1/)).toBeTruthy();

    fetchSpy.mockRestore();
    mockApi([{ path: PAGE_1, body: emptyModels }]);
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No models yet')).toBeTruthy();
  });
});
