import { buildSignInMessage } from '@ibt/shared';
import { useWallet, type WalletContextState } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearToken, getSession, getToken } from '../lib/auth';
import { TestProviders } from '../test-utils';
import { WalletGate } from './WalletGate';

vi.mock('@solana/wallet-adapter-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/wallet-adapter-react')>()),
  useWallet: vi.fn(),
}));

const fetchMock = vi.fn<typeof fetch>();
const useWalletMock = vi.mocked(useWallet);
const owner = new PublicKey(new Uint8Array(32).fill(1));
const wallet = owner.toBase58();
const nonce = 'n0nce-0123456789abcdef';
const signatureBytes = new Uint8Array(64).fill(7);

function sentBody(call: number): unknown {
  return JSON.parse(fetchMock.mock.calls[call]?.[1]?.body as string);
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function walletState(state: Partial<WalletContextState>): WalletContextState {
  return { publicKey: null, connecting: false, connected: false, ...state } as WalletContextState;
}

function message(forWallet = wallet) {
  return buildSignInMessage({
    domain: 'ibt.test',
    wallet: forWallet,
    nonce,
    issuedAt: '2026-10-02T10:00:00.000Z',
  });
}

function renderGate() {
  return render(
    <TestProviders>
      <WalletGate>
        <p>secret dashboard</p>
      </WalletGate>
    </TestProviders>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  useWalletMock.mockReturnValue(walletState({}));
  vi.unstubAllGlobals();
  clearToken();
});

describe('WalletGate', () => {
  it('asks to connect a wallet when none is connected', () => {
    useWalletMock.mockReturnValue(walletState({}));
    renderGate();
    expect(screen.getByRole('heading', { name: 'Sign in with wallet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
    expect(screen.queryByText('secret dashboard')).toBeNull();
  });

  it('signs the nonce message, verifies and keeps the JWT in memory only', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const signMessage = vi.fn((_bytes: Uint8Array) => Promise.resolve(signatureBytes));
    useWalletMock.mockReturnValue(walletState({ publicKey: owner, connected: true, signMessage }));
    fetchMock.mockResolvedValueOnce(json(200, { nonce, message: message() })).mockResolvedValueOnce(
      json(200, {
        token: 'jwt-abc',
        user: { id: '66f1a2b3c4d5e6f7a8b9c0d1', wallet, role: 'consumer' },
      }),
    );

    renderGate();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with wallet' }));

    expect(await screen.findByText('secret dashboard')).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://api.test/api/auth/nonce');
    expect(sentBody(0)).toEqual({ wallet });
    expect(new TextDecoder().decode(signMessage.mock.calls[0]?.[0])).toBe(message());
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://api.test/api/auth/verify');
    expect(sentBody(1)).toEqual({
      wallet,
      nonce,
      signature: bs58.encode(signatureBytes),
    });
    expect(getSession()).toEqual({ token: 'jwt-abc', wallet });
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
    expect(document.cookie).toBe('');
  });

  it('shows a plain error when the wallet rejects the signature', async () => {
    const signMessage = vi.fn(() => Promise.reject(new Error('User rejected the request.')));
    useWalletMock.mockReturnValue(walletState({ publicKey: owner, connected: true, signMessage }));
    fetchMock.mockResolvedValueOnce(json(200, { nonce, message: message() }));

    renderGate();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with wallet' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/declined/);
    expect(getToken()).toBeNull();
    expect(screen.queryByText('secret dashboard')).toBeNull();
  });

  it('refuses to sign a message that is not for this wallet', async () => {
    const signMessage = vi.fn(() => Promise.resolve(signatureBytes));
    useWalletMock.mockReturnValue(walletState({ publicKey: owner, connected: true, signMessage }));
    const other = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
    fetchMock.mockResolvedValueOnce(json(200, { nonce, message: message(other) }));

    renderGate();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with wallet' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/not recognised/);
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('clears the session when the wallet disconnects', async () => {
    const signMessage = vi.fn(() => Promise.resolve(signatureBytes));
    useWalletMock.mockReturnValue(walletState({ publicKey: owner, connected: true, signMessage }));
    fetchMock.mockResolvedValueOnce(json(200, { nonce, message: message() })).mockResolvedValueOnce(
      json(200, {
        token: 'jwt-abc',
        user: { id: '66f1a2b3c4d5e6f7a8b9c0d1', wallet, role: 'consumer' },
      }),
    );
    const view = renderGate();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with wallet' }));
    await screen.findByText('secret dashboard');

    useWalletMock.mockReturnValue(walletState({}));
    act(() => {
      view.rerender(
        <TestProviders>
          <WalletGate>
            <p>secret dashboard</p>
          </WalletGate>
        </TestProviders>,
      );
    });

    expect(getToken()).toBeNull();
    expect(screen.queryByText('secret dashboard')).toBeNull();
  });
});
