import { useWallet, type WalletContextState } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useSendTx,
  type SendTxOutcome,
  type SendTxRequest,
  type UseSendTx,
} from '../hooks/useSendTx';
import { TestProviders } from '../test-utils';
import { DEPOSIT_POLL_ATTEMPTS, DEPOSIT_POLL_INTERVAL_MS, DepositUsdc } from './DepositUsdc';

vi.mock('@solana/wallet-adapter-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/wallet-adapter-react')>()),
  useWallet: vi.fn(),
}));
vi.mock('../hooks/useSendTx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks/useSendTx')>()),
  useSendTx: vi.fn(),
}));

const SIG = '5Yx-deposit-signature';
const fetchMock = vi.fn<typeof fetch>();
let approve: () => void = () => undefined;
let walletRejects = false;

const send = vi.fn(async (request: SendTxRequest<unknown>): Promise<SendTxOutcome<unknown>> => {
  await new Promise<void>((resolve) => {
    approve = resolve;
  });
  if (walletRejects) {
    return {
      ok: false,
      signature: null,
      error: { code: 'wallet_rejected', message: 'You rejected the request in your wallet.' },
    };
  }
  try {
    return { ok: true, signature: SIG, result: await request.onConfirmed?.(SIG) };
  } catch (cause) {
    return {
      ok: false,
      signature: SIG,
      error: { code: 'unknown', message: cause instanceof Error ? cause.message : 'failed' },
    };
  }
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const pending = () =>
  json(202, { error: { code: 'deposit_pending', message: 'not finalized yet' } });
const credited = () =>
  json(200, { credited: true, amountUsdc: '25.000000', balanceUsdc: '31.420000' });

function phase() {
  return document.querySelector('[data-phase]')?.getAttribute('data-phase');
}

function submit(amount: string) {
  fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: amount } });
  fireEvent.click(screen.getByRole('button', { name: 'Deposit' }));
}

async function approveInWallet() {
  await waitFor(() => expect(send).toHaveBeenCalled());
  await act(async () => {
    approve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('fetch', fetchMock);
  walletRejects = false;
  vi.mocked(useWallet).mockReturnValue({
    publicKey: new PublicKey(new Uint8Array(32).fill(1)),
    connected: true,
  } as WalletContextState);
  vi.mocked(useSendTx).mockReturnValue({ send } as unknown as UseSendTx);
  render(
    <TestProviders>
      <DepositUsdc depositRef="AB12CD34" />
    </TestProviders>,
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  send.mockClear();
});

describe('DepositUsdc', () => {
  it('starts idle and rejects invalid amounts without opening the wallet', () => {
    expect(phase()).toBe('idle');
    submit('0');
    expect(screen.getByText(/greater than 0/)).toBeTruthy();
    submit('1.1234567');
    expect(screen.getByText(/up to 6 decimals/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('goes signing → pending → credited, polling a 202 every 5 s', async () => {
    fetchMock.mockResolvedValueOnce(pending()).mockResolvedValueOnce(credited());
    submit('25');
    await waitFor(() => expect(phase()).toBe('signing'));
    expect(screen.getByText(/Approve the transfer/)).toBeTruthy();

    await approveInWallet();
    await waitFor(() => expect(phase()).toBe('pending'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://api.test/api/billing/deposits');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ txSignature: SIG }));

    await act(() => vi.advanceTimersByTimeAsync(DEPOSIT_POLL_INTERVAL_MS));
    await waitFor(() => expect(phase()).toBe('credited'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Credited 25 USDC. Balance 31.42 USDC.')).toBeTruthy();
    expect(send.mock.calls[0]?.[0].invalidate).toContainEqual(['me']);
  });

  it('shows the wallet rejection as an error', async () => {
    walletRejects = true;
    submit('5');
    await approveInWallet();
    expect((await screen.findByRole('alert')).textContent).toMatch(/rejected/);
    expect(phase()).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a non-retryable api error', async () => {
    fetchMock.mockResolvedValueOnce(
      json(422, { error: { code: 'deposit_invalid', message: 'memo does not match depositRef' } }),
    );
    submit('5');
    await approveInWallet();
    expect((await screen.findByRole('alert')).textContent).toBe('memo does not match depositRef');
    expect(phase()).toBe('error');
  });

  it('treats 409 as already credited', async () => {
    fetchMock.mockResolvedValueOnce(
      json(409, { error: { code: 'deposit_already_credited', message: 'already credited' } }),
    );
    submit('5');
    await approveInWallet();
    expect(await screen.findByText('This deposit was already credited.')).toBeTruthy();
  });

  it('gives up after ~2 minutes of pending and lets the user check again', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(pending()));
    submit('5');
    await approveInWallet();
    await waitFor(() => expect(phase()).toBe('pending'));
    await act(() => vi.advanceTimersByTimeAsync(DEPOSIT_POLL_INTERVAL_MS * DEPOSIT_POLL_ATTEMPTS));
    await waitFor(() => expect(phase()).toBe('error'));
    expect(fetchMock).toHaveBeenCalledTimes(DEPOSIT_POLL_ATTEMPTS);
    expect(screen.getByRole('alert').textContent).toMatch(/two minutes/);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(credited());
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(phase()).toBe('credited'));
  });
});
