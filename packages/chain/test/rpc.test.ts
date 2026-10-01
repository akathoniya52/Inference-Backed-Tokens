import { Connection, PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRpc, RPC_BACKOFF_MS, type ReadConnection } from '../src/rpc.js';

function stubConnection(name: string, getBalance: ReadConnection['getBalance']): ReadConnection {
  const unused = (): never => {
    throw new Error(`${name}: not stubbed`);
  };
  return {
    getParsedTransaction: vi.fn<ReadConnection['getParsedTransaction']>(unused),
    getSignatureStatuses: vi.fn<ReadConnection['getSignatureStatuses']>(unused),
    getLatestBlockhash: vi.fn<ReadConnection['getLatestBlockhash']>(unused),
    getBlockHeight: vi.fn<ReadConnection['getBlockHeight']>(unused),
    getBalance: vi.fn(getBalance),
    getAccountInfo: vi.fn<ReadConnection['getAccountInfo']>(unused),
    getTokenAccountBalance: vi.fn<ReadConnection['getTokenAccountBalance']>(unused),
  };
}

const failing = (label: string) => () => Promise.reject(new Error(label));
const WALLET = new PublicKey('So11111111111111111111111111111111111111112');

function setup(opts: { primary: ReadConnection; fallback?: ReadConnection }) {
  const urls: string[] = [];
  const rpc = createRpc({
    rpcUrl: 'http://primary.invalid',
    ...(opts.fallback ? { fallbackUrl: 'http://fallback.invalid' } : {}),
    commitment: 'confirmed',
    createConnection: (url: string) => {
      urls.push(url);
      if (url === 'http://primary.invalid') return opts.primary;
      if (opts.fallback) return opts.fallback;
      throw new Error(`unexpected url ${url}`);
    },
  });
  return { rpc, urls };
}

describe('createRpc', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the L259 backoff schedule', () => {
    expect(RPC_BACKOFF_MS).toEqual([500, 2000, 8000]);
  });

  it('builds real Connections by default without any network call', () => {
    const rpc = createRpc({ rpcUrl: 'http://127.0.0.1:1', commitment: 'finalized' });
    expect(rpc.primary).toBeInstanceOf(Connection);
    expect(rpc.primary.commitment).toBe('finalized');
    expect(rpc.fallback).toBeNull();
  });

  it('returns the primary result on the first try without waiting', async () => {
    const primary = stubConnection('primary', () => Promise.resolve(42));
    const fallback = stubConnection('fallback', failing('fallback'));
    const { rpc, urls } = setup({ primary, fallback });

    await expect(rpc.read.getBalance(WALLET)).resolves.toBe(42);
    expect(urls).toEqual(['http://primary.invalid', 'http://fallback.invalid']);
    expect(primary.getBalance).toHaveBeenCalledWith(WALLET, 'confirmed');
    expect(fallback.getBalance).not.toHaveBeenCalled();
  });

  it('retries the primary after 500 ms on the 2nd attempt', async () => {
    const primary = stubConnection('primary', failing('p1'));
    vi.mocked(primary.getBalance).mockImplementationOnce(failing('p1')).mockResolvedValueOnce(7);
    const { rpc } = setup({ primary });

    const result = rpc.read.getBalance(WALLET);
    await vi.advanceTimersByTimeAsync(499);
    expect(primary.getBalance).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(7);
    expect(primary.getBalance).toHaveBeenCalledTimes(2);
  });

  it('uses fallback on 3rd attempt after two primary errors', async () => {
    const primary = stubConnection('primary', failing('primary down'));
    const fallback = stubConnection('fallback', () => Promise.resolve(9));
    const { rpc } = setup({ primary, fallback });

    const attempts: number[] = [];
    const result = rpc.withRetry((conn, attempt) => {
      attempts.push(attempt);
      return conn.getBalance(WALLET);
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(fallback.getBalance).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toBe(9);
    expect(attempts).toEqual([1, 2, 3]);
    expect(primary.getBalance).toHaveBeenCalledTimes(2);
    expect(fallback.getBalance).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after 4 attempts (2 primary, 2 fallback)', async () => {
    const primary = stubConnection('primary', failing('primary down'));
    const fallback = stubConnection('fallback', failing('fallback down'));
    const { rpc } = setup({ primary, fallback });

    const result = rpc.read.getBalance(WALLET);
    const assertion = expect(result).rejects.toThrow('fallback down');
    await vi.advanceTimersByTimeAsync(500 + 2000 + 8000);
    await assertion;
    expect(primary.getBalance).toHaveBeenCalledTimes(2);
    expect(fallback.getBalance).toHaveBeenCalledTimes(2);
  });

  it('stays on the primary for every attempt when no fallback is configured', async () => {
    const primary = stubConnection('primary', failing('primary down'));
    const { rpc } = setup({ primary });

    const assertion = expect(rpc.read.getBalance(WALLET)).rejects.toThrow('primary down');
    await vi.advanceTimersByTimeAsync(10_500);
    await assertion;
    expect(primary.getBalance).toHaveBeenCalledTimes(4);
  });

  it('does not retry errors that isRetryable rejects', async () => {
    const primary = stubConnection('primary', failing('bad request'));
    const rpc = createRpc({
      rpcUrl: 'http://primary.invalid',
      createConnection: () => primary,
      isRetryable: (err) => !(err instanceof Error && err.message === 'bad request'),
    });

    await expect(rpc.read.getBalance(WALLET)).rejects.toThrow('bad request');
    expect(primary.getBalance).toHaveBeenCalledTimes(1);
  });

  it('fetches parsed transactions with v0 support at the requested finality', async () => {
    const primary = stubConnection('primary', failing('unused'));
    vi.mocked(primary.getParsedTransaction).mockResolvedValue(null);
    const { rpc } = setup({ primary });

    await expect(rpc.read.getParsedTransaction('sig', 'finalized')).resolves.toBeNull();
    expect(primary.getParsedTransaction).toHaveBeenCalledWith('sig', {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
  });
});
