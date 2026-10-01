import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockApi, requestedPaths } from '../fixtures/mockApi';
import { CURVE_MINT, GRADUATED_MINT } from '../fixtures/models';
import {
  ADD_SIG,
  BUY_SIG,
  carriedSettlement,
  curveSettlementsPage,
  doneSettlement,
  emptySettlements,
  graduatedSettlement,
  LOCK_SIG,
  PAYOUT_SIG,
} from '../fixtures/tokens';
import { SETTLEMENTS_REFETCH_MS } from '../lib/queries';
import { TestProviders } from '../test-utils';
import { SettlementTable } from './SettlementTable';

const CURVE_PATH = `/api/tokens/${CURVE_MINT}/settlements`;

afterEach(() => {
  vi.restoreAllMocks();
});

function renderTable(mint: string, cluster?: 'devnet' | 'mainnet-beta') {
  return render(
    <TestProviders>
      <SettlementTable mint={mint} {...(cluster ? { cluster } : {})} />
    </TestProviders>,
  );
}

describe('SettlementTable', () => {
  it('renders settlement rows with amounts and state', async () => {
    mockApi([{ path: CURVE_PATH, body: curveSettlementsPage }]);
    renderTable(CURVE_MINT);

    const rows = await screen.findAllByRole('row');
    expect(rows).toHaveLength(3);
    const done = within(rows[1] as HTMLElement);
    expect(done.getByText('2 Oct 2026, 13:00–14:00 UTC')).toBeTruthy();
    expect(done.getByText('1,180')).toBeTruthy();
    expect(done.getByText('14.30')).toBeTruthy();
    expect(done.getByText('10.01')).toBeTruthy();
    expect(done.getByText('2.86 USDC')).toBeTruthy();
    expect(done.getByText('0.0191 SOL')).toBeTruthy();
    expect(done.getByText('Done')).toBeTruthy();

    const failed = within(rows[2] as HTMLElement);
    expect(failed.getByText('Failed')).toBeTruthy();
    expect(failed.getByText('0.588 carried')).toBeTruthy();
    expect(failed.queryAllByRole('link')).toHaveLength(0);
    expect(doneSettlement.state).toBe('done');
    expect(carriedSettlement.state).toBe('failed');
  });

  it('links every signature to Solscan with ?cluster=devnet on devnet', async () => {
    mockApi([{ path: CURVE_PATH, body: curveSettlementsPage }]);
    renderTable(CURVE_MINT);

    const payout = await screen.findByRole('link', { name: 'Payout transaction' });
    expect(payout.getAttribute('href')).toBe(`https://solscan.io/tx/${PAYOUT_SIG}?cluster=devnet`);
    expect(payout.getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: 'Buy transaction' }).getAttribute('href')).toBe(
      `https://solscan.io/tx/${BUY_SIG}?cluster=devnet`,
    );
  });

  it('omits the cluster query on mainnet-beta', async () => {
    mockApi([
      {
        path: `/api/tokens/${GRADUATED_MINT}/settlements`,
        body: { items: [graduatedSettlement], nextCursor: null },
      },
    ]);
    renderTable(GRADUATED_MINT, 'mainnet-beta');

    const payout = await screen.findByRole('link', { name: 'Payout transaction' });
    expect(payout.getAttribute('href')).toBe(`https://solscan.io/tx/${PAYOUT_SIG}`);
    expect(
      screen.getByRole('link', { name: 'Add liquidity transaction' }).getAttribute('href'),
    ).toBe(`https://solscan.io/tx/${ADD_SIG}`);
    expect(screen.getByRole('link', { name: 'Lock transaction' }).getAttribute('href')).toBe(
      `https://solscan.io/tx/${LOCK_SIG}`,
    );
  });

  it('shows an empty ledger', async () => {
    mockApi([{ path: CURVE_PATH, body: emptySettlements }]);
    renderTable(CURVE_MINT);
    expect(await screen.findByText('No settlements yet')).toBeTruthy();
  });

  it('pages with the cursor and refetches every 60 s', async () => {
    const spy = mockApi([
      { path: CURVE_PATH, body: { items: [doneSettlement], nextCursor: 'next-1' } },
      {
        path: `${CURVE_PATH}?cursor=next-1`,
        body: { items: [carriedSettlement], nextCursor: null },
      },
    ]);
    renderTable(CURVE_MINT);

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Failed')).toBeTruthy();
    expect(requestedPaths(spy)).toEqual([CURVE_PATH, `${CURVE_PATH}?cursor=next-1`]);
    expect(SETTLEMENTS_REFETCH_MS).toBe(60_000);
  });
});
