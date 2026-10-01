import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockApi, requestedPaths } from '../fixtures/mockApi';
import { CURVE_MINT, GRADUATED_MINT } from '../fixtures/models';
import { curveTokenState, graduatedTokenState } from '../fixtures/tokens';
import { TOKEN_STATE_REFETCH_MS } from '../lib/queries';
import { TestProviders } from '../test-utils';
import { CurveProgress, CurveProgressView } from './CurveProgress';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CurveProgress', () => {
  it('renders 42% and SOL raised vs the devnet threshold from the token state', async () => {
    const fetchSpy = mockApi([{ path: `/api/tokens/${CURVE_MINT}/state`, body: curveTokenState }]);
    render(
      <TestProviders>
        <CurveProgress mint={CURVE_MINT} />
      </TestProviders>,
    );

    const bar = await screen.findByRole('progressbar', { name: 'Bonding curve progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-valuetext')).toBe('42%, 0.42 of 1 SOL raised');
    expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.getByText('0.42 SOL raised')).toBeTruthy();
    expect(screen.getByText('of 1 SOL to graduate')).toBeTruthy();
    expect(requestedPaths(fetchSpy)).toEqual([`/api/tokens/${CURVE_MINT}/state`]);
  });

  it('polls the state every 10 s', () => {
    expect(TOKEN_STATE_REFETCH_MS).toBe(10_000);
  });

  it('shows the graduated state at 100%', async () => {
    mockApi([{ path: `/api/tokens/${GRADUATED_MINT}/state`, body: graduatedTokenState }]);
    render(
      <TestProviders>
        <CurveProgress mint={GRADUATED_MINT} />
      </TestProviders>,
    );
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByText('Graduated to DAMM v2')).toBeTruthy();
  });

  it('reports an unavailable state when the request fails', async () => {
    mockApi([]);
    render(
      <TestProviders>
        <CurveProgress mint={CURVE_MINT} />
      </TestProviders>,
    );
    expect(await screen.findByText('Curve state unavailable')).toBeTruthy();
  });
});

describe('CurveProgressView', () => {
  it('uses the mainnet threshold and clamps progress', () => {
    render(<CurveProgressView progress={1.2} raisedSol="10.5" thresholdSol={10} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByText('of 10 SOL to graduate')).toBeTruthy();
    expect(screen.getByText('10.5 SOL raised')).toBeTruthy();
  });
});
