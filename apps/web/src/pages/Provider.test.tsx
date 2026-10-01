import { useWallet, type WalletContextState } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockApi } from '../fixtures/mockApi';
import { curveModel, CURVE_MINT, graduatedModel, unlaunchedModel } from '../fixtures/models';
import { curveSettlementsPage, PAYOUT_SIG } from '../fixtures/tokens';
import { clearToken, setToken } from '../lib/auth';
import { renderRoute } from '../test-utils';

vi.mock('@solana/wallet-adapter-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/wallet-adapter-react')>()),
  useWallet: vi.fn(),
}));

const PROVIDER = curveModel.providerWallet;

function connect(wallet: string | null) {
  vi.mocked(useWallet).mockReturnValue({
    publicKey: wallet === null ? null : new PublicKey(wallet),
    connected: wallet !== null,
  } as unknown as WalletContextState);
}

function mockProviderApi() {
  return mockApi([
    {
      path: '/api/models?limit=100',
      body: { items: [curveModel, graduatedModel], nextCursor: 'next' },
    },
    {
      path: '/api/models?cursor=next&limit=100',
      body: { items: [unlaunchedModel], nextCursor: null },
    },
    { path: `/api/tokens/${CURVE_MINT}/settlements`, body: curveSettlementsPage },
    {
      path: `/api/models/${curveModel.id}`,
      body: {
        ...curveModel,
        status: 'paused',
        upstream: { baseUrl: 'https://u.example/v1', modelName: 'm', supportsStreamUsage: false },
      },
    },
  ]);
}

beforeEach(() => {
  connect(PROVIDER);
  setToken('jwt', PROVIDER);
});

afterEach(() => {
  // Unmount before signing out so the old tree never re-renders without mocks.
  cleanup();
  clearToken();
  vi.restoreAllMocks();
});

describe('ProviderPage', () => {
  it('asks for a wallet sign-in first', () => {
    clearToken();
    connect(null);
    mockProviderApi();
    renderRoute('/provider');
    expect(screen.getByRole('heading', { name: 'Sign in with wallet' })).toBeTruthy();
  });

  it('lists only the signed-in provider models with payouts, claims and pause', async () => {
    const fetchSpy = mockProviderApi();
    renderRoute('/provider');

    expect(await screen.findByRole('heading', { level: 2, name: curveModel.name })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: unlaunchedModel.name })).toBeTruthy();
    expect(screen.queryByText(graduatedModel.name)).toBeNull();
    expect(screen.getByText('14.30 USDC', { selector: 'dd' })).toBeTruthy();

    const payout = await screen.findByRole('link', {
      name: `${PAYOUT_SIG.slice(0, 4)}…${PAYOUT_SIG.slice(-4)}`,
    });
    expect(payout.getAttribute('href')).toBe(`https://solscan.io/tx/${PAYOUT_SIG}?cluster=devnet`);
    expect(screen.getByText('0.59 carried over')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Claim fees' })).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: `Pause ${curveModel.name}` })[0]!);
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true),
    );
    const [url, init] =
      fetchSpy.mock.calls.find(([, options]) => options?.method === 'PATCH') ?? [];
    expect(url).toBe(`http://api.test/api/models/${curveModel.id}`);
    expect(typeof init?.body === 'string' ? JSON.parse(init.body) : null).toEqual({
      status: 'paused',
    });
  });
});
