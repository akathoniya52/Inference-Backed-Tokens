import { ModelSchema } from '@ibt/shared';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  useConnection,
  useWallet,
  type ConnectionContextState,
  type WalletContextState,
} from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, type Connection, type Keypair } from '@solana/web3.js';
import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import bs58 from 'bs58';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearToken, setToken } from '../lib/auth';
import { metadataUri } from '../lib/launch';
import { TestProviders } from '../test-utils';
import { LaunchWizard } from './LaunchWizard';

const { createPool } = vi.hoisted(() => ({
  createPool: vi.fn<(params: { config: { toBase58(): string } }) => Promise<unknown>>(),
}));
vi.mock('@meteora-ag/dynamic-bonding-curve-sdk', () => ({
  DynamicBondingCurveClient: vi.fn(() => ({ creator: { createPool } })),
}));
// The shared vitest placeholder is not a valid public key; createPool needs one.
vi.mock('../env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env')>();
  return {
    ...actual,
    env: { ...actual.env, VITE_DBC_CONFIG: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN' },
  };
});
vi.mock('@solana/wallet-adapter-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/wallet-adapter-react')>()),
  useWallet: vi.fn(),
  useConnection: vi.fn(),
}));

const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill));
const owner = key(1);
const mint = { publicKey: key(5) } as unknown as Keypair;
const MODEL_ID = '66f1a2b3c4d5e6f7a8b9c0d1';
const SIG = 'launch-signature';
const partialSign = vi.fn();

const connection = {
  getLatestBlockhash: vi.fn(() =>
    Promise.resolve({ blockhash: key(9).toBase58(), lastValidBlockHeight: 99 }),
  ),
  simulateTransaction: vi.fn(() => Promise.resolve({ value: { err: null, logs: [] } })),
  sendRawTransaction: vi.fn(() => Promise.resolve(SIG)),
  confirmTransaction: vi.fn(() => Promise.resolve({ value: { err: null } })),
};
const signTransaction = vi.fn(<T,>(tx: T): Promise<T> => {
  (tx as Transaction).serialize = () => Buffer.from([1]);
  return Promise.resolve(tx);
});

const ownerModel = {
  id: MODEL_ID,
  slug: 'llama-fast',
  name: 'Llama Fast',
  description: '',
  imageUrl: null,
  providerWallet: owner.toBase58(),
  status: 'active',
  pricing: { inputPerMTokUsdc: '0.200000', outputPerMTokUsdc: '0.600000' },
  splits: { providerBps: 7000, liquidityBps: 2000, platformBps: 1000 },
  health: { lastOkAt: null, p50LatencyMs: null, consecutiveFailures: 0 },
  token: {
    status: 'none',
    symbol: null,
    mint: null,
    dbcPool: null,
    dammV2Pool: null,
    launchSignature: null,
    migrationSignature: null,
    keeperPosition: null,
  },
  stats: { requests24h: 0, successRate: 1, revenueUsdc24h: '0' },
  createdAt: '2026-10-01T10:00:00.000Z',
  upstream: {
    baseUrl: 'https://api.example.com/v1',
    modelName: 'llama',
    supportsStreamUsage: false,
  },
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();
let healthOk = true;
let confirmResponse: (() => Response) | null = null;
let prepareMetadataUri: string | undefined;
const SENT_SIG = bs58.encode(new Uint8Array(64).fill(3));
const STORAGE_KEY = 'ibt:launch:llama-fast';

function calledPaths(): string[] {
  return fetchMock.mock.calls.map(
    ([input, init]) => `${init?.method ?? 'GET'} ${new URL(input as string).pathname}`,
  );
}

function body(path: string): unknown {
  const call = fetchMock.mock.calls.find(([input]) => new URL(input as string).pathname === path);
  return JSON.parse(call?.[1]?.body as string);
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fillRegistration(overrides: Record<string, string> = {}) {
  const values = {
    'Display name': 'Llama Fast',
    Slug: 'llama-fast',
    'Upstream base URL': 'https://api.example.com/v1',
    'Upstream model name': 'llama',
    'Upstream API key': 'sk-upstream',
    'Input price (USDC / 1M tokens)': '0.2',
    'Output price (USDC / 1M tokens)': '0.6',
    ...overrides,
  };
  for (const [label, value] of Object.entries(values)) fill(label, value);
}

async function reachStep(target: 'health' | 'prices' | 'launch') {
  fillRegistration();
  fireEvent.click(screen.getByRole('button', { name: 'Register model' }));
  await screen.findByRole('heading', { name: 'Check the endpoint' });
  if (target === 'health') return;
  fireEvent.click(screen.getByRole('button', { name: 'Run health check' }));
  await screen.findByLabelText('Health check result');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Set prices' });
  if (target === 'prices') return;
  fireEvent.click(screen.getByRole('button', { name: 'Save prices' }));
  await screen.findByRole('heading', { name: 'Launch the token' });
}

beforeEach(() => {
  setToken('jwt', owner.toBase58());
  healthOk = true;
  createPool.mockImplementation(() => {
    const tx = new Transaction();
    tx.partialSign = partialSign;
    return Promise.resolve(tx);
  });
  const context: ConnectionContextState = { connection: connection as unknown as Connection };
  vi.mocked(useConnection).mockReturnValue(context);
  vi.mocked(useWallet).mockReturnValue({
    publicKey: owner,
    connected: true,
    signTransaction,
  } as unknown as WalletContextState);
  fetchMock.mockImplementation((input, init) => {
    const path = `${init?.method ?? 'GET'} ${new URL(input as string).pathname}`;
    const responses: Record<string, () => Response> = {
      'POST /api/models': () => json(201, ownerModel),
      [`POST /api/models/${MODEL_ID}/health-check`]: () =>
        json(
          200,
          healthOk
            ? { ok: true, latencyMs: 412, status: 'active', consecutiveFailures: 0 }
            : {
                ok: false,
                latencyMs: null,
                status: 'active',
                consecutiveFailures: 1,
                error: 'upstream returned 401',
              },
        ),
      [`PATCH /api/models/${MODEL_ID}`]: () => json(200, ownerModel),
      'POST /api/tokens/launch/prepare': () =>
        json(200, {
          token: { status: 'pending', mint: mint.publicKey.toBase58() },
          ...(prepareMetadataUri === undefined ? {} : { metadataUri: prepareMetadataUri }),
        }),
      'POST /api/tokens/launch/confirm': () =>
        confirmResponse?.() ??
        json(200, {
          token: {
            status: 'curve',
            mint: mint.publicKey.toBase58(),
            dbcPool: key(7).toBase58(),
            progress: 0,
          },
        }),
    };
    const respond = responses[path];
    return Promise.resolve(
      respond ? respond() : json(404, { error: { code: 'not_found', message: path } }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <TestProviders>
      <MemoryRouter>
        <LaunchWizard generateMint={() => mint} />
      </MemoryRouter>
    </TestProviders>,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  clearToken();
  confirmResponse = null;
  prepareMetadataUri = undefined;
  window.localStorage.clear();
});

function renderResumed(resume: unknown) {
  cleanup();
  render(
    <TestProviders>
      <MemoryRouter>
        <LaunchWizard generateMint={() => mint} resume={ModelSchema.parse(resume)} />
      </MemoryRouter>
    </TestProviders>,
  );
}

const pendingModel = {
  ...ownerModel,
  token: { ...ownerModel.token, status: 'pending', symbol: 'LLAMA', mint: key(5).toBase58() },
};

describe('LaunchWizard', () => {
  it('validates the registration form before calling the api', () => {
    fillRegistration({
      'Upstream base URL': 'ftp://nope',
      Slug: 'Bad Slug',
      'Input price (USDC / 1M tokens)': '0',
      'Output price (USDC / 1M tokens)': 'abc',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register model' }));
    expect(screen.getByText('Enter an http(s) URL')).toBeTruthy();
    expect(screen.getByText(/slug must be/)).toBeTruthy();
    expect(screen.getByText('must be greater than 0')).toBeTruthy();
    expect(screen.getByText(/USDC with up to 6 decimals/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Register your endpoint' })).toBeTruthy();
  });

  it('gates the steps: no continue until the health check passes', async () => {
    healthOk = false;
    await reachStep('health');
    expect(body('/api/models')).toMatchObject({
      slug: 'llama-fast',
      upstream: {
        baseUrl: 'https://api.example.com/v1',
        modelName: 'llama',
        apiKey: 'sk-upstream',
      },
      pricing: { inputPerMTokUsdc: '0.2', outputPerMTokUsdc: '0.6' },
    });
    const next = screen.getByRole('button', { name: 'Continue' });
    expect(next.hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Run health check' }));
    expect(await screen.findByText('upstream returned 401')).toBeTruthy();
    expect(next.hasAttribute('disabled')).toBe(true);

    healthOk = true;
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    await screen.findByText('Healthy');
    expect(screen.getByText('412 ms')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(false);
    expect(document.querySelector('[data-state="locked"]')?.textContent).toMatch(/Prices/);
  });

  it('validates prices and PATCHes them', async () => {
    await reachStep('prices');
    fill('Input price (USDC / 1M tokens)', '-1');
    fireEvent.click(screen.getByRole('button', { name: 'Save prices' }));
    expect(screen.getByText(/USDC with up to 6 decimals/)).toBeTruthy();

    fill('Input price (USDC / 1M tokens)', '0.25');
    fireEvent.click(screen.getByRole('button', { name: 'Save prices' }));
    await screen.findByRole('heading', { name: 'Launch the token' });
    expect(body(`/api/models/${MODEL_ID}`)).toEqual({
      pricing: { inputPerMTokUsdc: '0.25', outputPerMTokUsdc: '0.6' },
    });
  });

  it('rejects a bad symbol', async () => {
    await reachStep('launch');
    fill('Token symbol', 'x');
    fireEvent.click(screen.getByRole('button', { name: 'Launch token' }));
    expect(screen.getByText(/2–10 uppercase/)).toBeTruthy();
    fill('Token symbol', 'TOOLONGSYMBOL');
    fireEvent.click(screen.getByRole('button', { name: 'Launch token' }));
    expect(screen.getByText(/2–10 uppercase/)).toBeTruthy();
    expect(calledPaths()).not.toContain('POST /api/tokens/launch/prepare');
  });

  it('prepares before the wallet signs, then confirms and links the token page', async () => {
    await reachStep('launch');
    fill('Token symbol', 'llama');
    fireEvent.click(screen.getByRole('button', { name: 'Launch token' }));

    const link = await screen.findByRole('link', { name: 'View token page' });
    expect(link.getAttribute('href')).toBe('/t/llama-fast');

    const prepareCall = fetchMock.mock.calls.findIndex(([input]) =>
      String(new URL(input as string).pathname).endsWith('/launch/prepare'),
    );
    const confirmCall = fetchMock.mock.calls.findIndex(([input]) =>
      String(new URL(input as string).pathname).endsWith('/launch/confirm'),
    );
    const prepareOrder = fetchMock.mock.invocationCallOrder[prepareCall] ?? Infinity;
    const confirmOrder = fetchMock.mock.invocationCallOrder[confirmCall] ?? -Infinity;
    const signOrder = signTransaction.mock.invocationCallOrder[0] ?? 0;
    expect(prepareOrder).toBeLessThan(createPool.mock.invocationCallOrder[0] ?? 0);
    expect(prepareOrder).toBeLessThan(signOrder);
    expect(signOrder).toBeLessThan(confirmOrder);

    expect(body('/api/tokens/launch/prepare')).toEqual({
      modelId: MODEL_ID,
      mint: mint.publicKey.toBase58(),
      symbol: 'LLAMA',
    });
    expect(body('/api/tokens/launch/confirm')).toEqual({
      modelId: MODEL_ID,
      mint: mint.publicKey.toBase58(),
      signature: SIG,
    });
    expect(vi.mocked(DynamicBondingCurveClient)).toHaveBeenCalledWith(connection, 'confirmed');
    expect(createPool.mock.calls[0]?.[0]).toMatchObject({
      name: 'Llama Fast',
      symbol: 'LLAMA',
      uri: `http://api.test/metadata/${mint.publicKey.toBase58()}.json`,
      payer: owner,
      poolCreator: owner,
      baseMint: mint.publicKey,
    });
    expect(createPool.mock.calls[0]?.[0].config.toBase58()).toBe(
      'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
    );
    expect(partialSign).toHaveBeenCalledWith(mint);
    expect(partialSign.mock.invocationCallOrder[0]).toBeLessThan(signOrder);
  });

  it('builds the pool with the metadata URI that prepare returned (API-06)', async () => {
    prepareMetadataUri = `https://api.prod.example/metadata/${mint.publicKey.toBase58()}.json`;
    await reachStep('launch');
    fill('Token symbol', 'LLAMA');
    fireEvent.click(screen.getByRole('button', { name: 'Launch token' }));
    await screen.findByRole('link', { name: 'View token page' });
    expect(createPool.mock.calls[0]?.[0]).toMatchObject({ uri: prepareMetadataUri });
  });

  it('refuses a returned metadata URI that is not https or not for this mint', async () => {
    prepareMetadataUri = `http://api.prod.example/metadata/${mint.publicKey.toBase58()}.json`;
    await reachStep('launch');
    fill('Token symbol', 'LLAMA');
    fireEvent.click(screen.getByRole('button', { name: 'Launch token' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/unexpected token metadata URI/),
    );
    expect(createPool).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
    const own = `/metadata/${mint.publicKey.toBase58()}.json`;
    expect(() => metadataUri(mint.publicKey, 'https://api.prod.example/metadata/x.json')).toThrow();
    expect(() => metadataUri(mint.publicKey, `https://api.prod.example${own}?x=1`)).toThrow();
    expect(() => metadataUri(mint.publicKey, `javascript:alert(1)//${own}`)).toThrow();
    expect(metadataUri(mint.publicKey, `http://localhost:4000${own}`)).toBe(
      `http://localhost:4000${own}`,
    );
  });

  it('shows the launch error and does not confirm when the wallet rejects', async () => {
    await reachStep('launch');
    signTransaction.mockRejectedValueOnce(new Error('User rejected the request.'));
    fill('Token symbol', 'LLAMA');
    fireEvent.click(screen.getByRole('button', { name: 'Launch token' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/rejected/i));
    expect(calledPaths()).not.toContain('POST /api/tokens/launch/confirm');
  });

  it('offers "Retry confirmation" instead of a second pool when confirm fails', async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    connection.sendRawTransaction.mockResolvedValueOnce(SENT_SIG);
    confirmResponse = () => json(503, { error: { code: 'upstream_error', message: 'try later' } });
    await reachStep('launch');
    fill('Token symbol', 'LLAMA');
    fireEvent.click(screen.getByRole('button', { name: 'Launch token' }));

    const retry = await screen.findByRole('button', { name: 'Retry confirmation' });
    expect(screen.queryByRole('button', { name: 'Launch token' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard and launch again' })).toBeNull();
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown;
    expect(stored).toEqual({
      v: 1,
      modelId: MODEL_ID,
      mint: mint.publicKey.toBase58(),
      symbol: 'LLAMA',
      signature: SENT_SIG,
    });

    confirmResponse = null;
    fireEvent.click(retry);
    expect(await screen.findByRole('link', { name: 'View token page' })).toBeTruthy();
    expect(createPool).toHaveBeenCalledTimes(1);
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(body('/api/tokens/launch/confirm')).toEqual({
      modelId: MODEL_ID,
      mint: mint.publicKey.toBase58(),
      signature: SENT_SIG,
    });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['models', 'list'],
        ['model', 'llama-fast'],
        ['tokenState', mint.publicKey.toBase58()],
        ['providerModels'],
      ]),
    );
  });

  it('re-uses the same mint when the wallet rejects and the user tries again', async () => {
    const generate = vi.fn(() => mint);
    cleanup();
    render(
      <TestProviders>
        <MemoryRouter>
          <LaunchWizard generateMint={generate} resume={ModelSchema.parse(ownerModel)} />
        </MemoryRouter>
      </TestProviders>,
    );
    signTransaction.mockRejectedValueOnce(new Error('User rejected the request.'));
    fill('Token symbol', 'LLAMA');
    fireEvent.click(screen.getByRole('button', { name: 'Launch token' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/rejected/i));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Launch token' }));
    expect(await screen.findByRole('link', { name: 'View token page' })).toBeTruthy();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('resumes a registered model at the launch step without registering it again', async () => {
    renderResumed(ownerModel);
    expect(screen.getByRole('heading', { name: 'Launch the token' })).toBeTruthy();
    fill('Token symbol', 'LLAMA');
    fireEvent.click(screen.getByRole('button', { name: 'Launch token' }));

    expect(await screen.findByRole('link', { name: 'View token page' })).toBeTruthy();
    expect(calledPaths()).not.toContain('POST /api/models');
    expect(calledPaths()).toContain('POST /api/tokens/launch/prepare');
  });

  it('after a reload, confirms the stored attempt instead of launching again', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        modelId: MODEL_ID,
        mint: key(5).toBase58(),
        symbol: 'LLAMA',
        signature: SENT_SIG,
      }),
    );
    renderResumed(pendingModel);
    expect(screen.queryByRole('button', { name: 'Launch token' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry confirmation' }));

    expect(await screen.findByRole('link', { name: 'View token page' })).toBeTruthy();
    expect(calledPaths()).not.toContain('POST /api/tokens/launch/prepare');
    expect(createPool).not.toHaveBeenCalled();
  });

  it('ignores a stored attempt with a bad shape or for another mint', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, mint: 'x', secretKey: [1] }));
    renderResumed(pendingModel);
    expect(screen.getByRole('button', { name: 'Launch token' })).toBeTruthy();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        modelId: MODEL_ID,
        mint: key(6).toBase58(),
        symbol: 'LLAMA',
        signature: SENT_SIG,
      }),
    );
    renderResumed(pendingModel);
    expect(screen.getByRole('button', { name: 'Launch token' })).toBeTruthy();
  });

  it('allows starting over only once the api finds no pool for the signature', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        modelId: MODEL_ID,
        mint: key(5).toBase58(),
        symbol: 'LLAMA',
        signature: SENT_SIG,
      }),
    );
    confirmResponse = () =>
      json(422, { error: { code: 'pool_mismatch', message: 'launch transaction failed' } });
    renderResumed(pendingModel);
    fireEvent.click(screen.getByRole('button', { name: 'Retry confirmation' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Discard and launch again' }));
    expect(screen.getByRole('button', { name: 'Launch token' })).toBeTruthy();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
