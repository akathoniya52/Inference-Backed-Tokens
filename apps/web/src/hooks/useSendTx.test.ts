import { WalletSignTransactionError } from '@solana/wallet-adapter-base';
import {
  useConnection,
  useWallet,
  type ConnectionContextState,
  type WalletContextState,
} from '@solana/wallet-adapter-react';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionExpiredBlockheightExceededError,
  type Connection,
} from '@solana/web3.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { mapSendTxError, useSendTx, type BuildContext } from './useSendTx';

vi.mock('@solana/wallet-adapter-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/wallet-adapter-react')>()),
  useWallet: vi.fn(),
  useConnection: vi.fn(),
}));

// Fixed keys keep the tests deterministic.
const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill));
const payer = { publicKey: key(1) };
const blockhash = key(9).toBase58();
const lastValidBlockHeight = 1234;
const SIG = 'sig-1';

const connection = {
  getLatestBlockhash: vi.fn(),
  simulateTransaction: vi.fn(),
  sendRawTransaction: vi.fn(),
  confirmTransaction: vi.fn(),
};
// The fake wallet stamps a stub wire format instead of signing for real.
function walletSign<T>(tx: T): T {
  (tx as Transaction).serialize = () => Buffer.from([1, 2, 3]);
  return tx;
}
const signTransaction = vi.fn(<T>(tx: T): Promise<T> => Promise.resolve(walletSign(tx)));
const sendTransaction = vi.fn();
let queryClient: QueryClient;

function transferTx() {
  // Layout-encoded instructions (SystemProgram, spl-token) fail under jsdom.
  return new Transaction().add(
    new TransactionInstruction({
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
      programId: key(2),
      data: Buffer.from([1]),
    }),
  );
}

function setup(wallet: Partial<WalletContextState> = {}) {
  const context: ConnectionContextState = { connection: connection as unknown as Connection };
  vi.mocked(useConnection).mockReturnValue(context);
  vi.mocked(useWallet).mockReturnValue({
    publicKey: payer.publicKey,
    connected: true,
    signTransaction,
    sendTransaction,
    ...wallet,
  } as WalletContextState);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => useSendTx(), { wrapper });
}

beforeEach(() => {
  queryClient = new QueryClient();
  connection.getLatestBlockhash.mockResolvedValue({ blockhash, lastValidBlockHeight });
  connection.simulateTransaction.mockResolvedValue({ value: { err: null, logs: [] } });
  connection.sendRawTransaction.mockResolvedValue(SIG);
  connection.confirmTransaction.mockResolvedValue({ value: { err: null } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSendTx', () => {
  it('builds, simulates, signs, sends, confirms, calls onConfirmed and invalidates', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const build = vi.fn((_ctx: BuildContext) => Promise.resolve(transferTx()));
    const onConfirmed = vi.fn((signature: string) => Promise.resolve(`done:${signature}`));
    const { result } = setup();

    let outcome: Awaited<ReturnType<typeof result.current.send<string>>> | undefined;
    await act(async () => {
      outcome = await result.current.send({ build, onConfirmed, invalidate: [['me']] });
    });

    expect(outcome).toEqual({ ok: true, signature: SIG, result: 'done:sig-1' });
    expect(build.mock.calls[0]?.[0]).toMatchObject({ blockhash, lastValidBlockHeight });
    expect(connection.confirmTransaction).toHaveBeenCalledWith(
      { signature: SIG, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    const order = [
      build,
      connection.simulateTransaction,
      signTransaction,
      connection.sendRawTransaction,
      connection.confirmTransaction,
      onConfirmed,
    ].map((fn) => fn.mock.invocationCallOrder[0] ?? 0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me'] });
    expect(result.current.status).toBe('confirmed');
    expect(result.current.signature).toBe(SIG);
  });

  it('reports the signing state while the wallet prompt is open', async () => {
    let approve: () => void = () => undefined;
    signTransaction.mockImplementationOnce(
      <T>(tx: T) =>
        new Promise<T>((resolve) => {
          approve = () => {
            resolve(walletSign(tx));
          };
        }),
    );
    const { result } = setup();
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.send({ build: () => Promise.resolve(transferTx()) });
    });
    await waitFor(() => expect(result.current.status).toBe('signing'));
    await act(async () => {
      approve();
      await pending;
    });
    expect(result.current.status).toBe('confirmed');
  });

  it('maps a wallet rejection and never sends', async () => {
    signTransaction.mockRejectedValueOnce(
      new WalletSignTransactionError('User rejected the request.'),
    );
    const { result } = setup();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.send({ build: () => Promise.resolve(transferTx()) });
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'wallet_rejected' } });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(result.current.status).toBe('failed');
    expect(result.current.error?.message).toMatch(/rejected/);
  });

  it('stops before signing when simulation fails on slippage', async () => {
    connection.simulateTransaction.mockResolvedValueOnce({
      value: {
        err: { InstructionError: [0, { Custom: 6001 }] },
        logs: ['Program log: Error: ExceededSlippage', 'custom program error: 0x1771'],
      },
    });
    const { result } = setup();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.send({ build: () => Promise.resolve(transferTx()) });
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'slippage' } });
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('never shows raw simulation JSON for an unrecognised program error', async () => {
    connection.simulateTransaction.mockResolvedValueOnce({
      value: { err: { InstructionError: [1, { Custom: 6042 }] }, logs: ['Program log: odd'] },
    });
    const { result } = setup();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.send({ build: () => Promise.resolve(transferTx()) });
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'simulation_failed' } });
    expect(result.current.error?.message).not.toMatch(/InstructionError|\{/);
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('maps an on-chain failure without dumping its JSON and reports onSent first', async () => {
    connection.confirmTransaction.mockResolvedValueOnce({
      value: { err: { InstructionError: [0, { Custom: 6042 }] } },
    });
    const onSent = vi.fn();
    const { result } = setup();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.send({ build: () => Promise.resolve(transferTx()), onSent });
    });
    expect(onSent).toHaveBeenCalledWith(SIG);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'transaction_failed' } });
    expect(result.current.error?.message).not.toMatch(/InstructionError/);
  });

  it('maps an expired blockhash during confirmation and keeps the signature', async () => {
    connection.confirmTransaction.mockRejectedValueOnce(
      new TransactionExpiredBlockheightExceededError(SIG),
    );
    const onConfirmed = vi.fn();
    const { result } = setup();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.send({
        build: () => Promise.resolve(transferTx()),
        onConfirmed,
      });
    });
    expect(outcome).toMatchObject({
      ok: false,
      signature: SIG,
      error: { code: 'blockhash_expired' },
    });
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('falls back to sendTransaction when the wallet cannot sign alone', async () => {
    sendTransaction.mockResolvedValueOnce('sig-2');
    const { result } = setup({ signTransaction: undefined });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.send({ build: () => Promise.resolve(transferTx()) });
    });
    expect(outcome).toMatchObject({ ok: true, signature: 'sig-2' });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('fails cleanly without a connected wallet', async () => {
    const build = vi.fn();
    const { result } = setup({ publicKey: null, connected: false });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.send({ build });
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'unknown' } });
    expect(build).not.toHaveBeenCalled();
  });
});

describe('mapSendTxError', () => {
  it.each([
    [
      new Error('Attempt to debit an account but found no record of a prior credit.'),
      'insufficient_sol',
    ],
    [new Error('Transfer: insufficient lamports 10, need 20'), 'insufficient_sol'],
    [new Error('Simulation failed: "AccountNotFound"'), 'account_not_found'],
    [new Error('Program log: Error: insufficient funds'), 'insufficient_funds'],
    [new Error('Simulation failed: {"InstructionError":[2,{"Custom":1}]}'), 'insufficient_funds'],
    [new Error('custom program error: 0x1'), 'insufficient_funds'],
    [new Error('Blockhash not found'), 'blockhash_expired'],
    [new Error('something odd'), 'unknown'],
  ])('maps %s', (error, code) => {
    expect(mapSendTxError(error).code).toBe(code);
  });

  it('never shows AccountNotFound as a SOL shortfall', () => {
    expect(mapSendTxError(new Error('Simulation failed: "AccountNotFound"')).message).not.toMatch(
      /Not enough SOL/,
    );
  });

  it('passes API error messages through', () => {
    const error = new ApiError({
      code: 'pool_mismatch',
      message: 'pool creator is not the model owner',
      requestId: null,
      status: 422,
    });
    expect(mapSendTxError(error)).toEqual({
      code: 'unknown',
      message: 'pool creator is not the model owner',
    });
  });
});
