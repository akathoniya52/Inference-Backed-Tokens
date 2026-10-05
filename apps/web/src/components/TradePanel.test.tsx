import {
  useConnection,
  useWallet,
  type ConnectionContextState,
  type WalletContextState,
} from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, TransactionInstruction, type Connection } from '@solana/web3.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CURVE_DBC_POOL,
  CURVE_MINT,
  curveModel,
  GRADUATED_DAMM_POOL,
  GRADUATED_MINT,
  graduatedModel,
  unlaunchedModel,
} from '../fixtures/models';
import { buildTradeTransaction, NATIVE_MINT, type TradeTarget } from '../lib/trade';
import { TestProviders } from '../test-utils';
import { TradePanel, tradeTarget } from './TradePanel';

const sdk = vi.hoisted(() => {
  const bn = (value: string | number | bigint) => ({ toString: () => String(value) });
  return {
    bn,
    getPool: vi.fn(),
    getPoolConfig: vi.fn(),
    swapQuote2: vi.fn(),
    dbcSwap2: vi.fn(),
    fetchPoolState: vi.fn(),
    getQuote2: vi.fn(),
    dammSwap2: vi.fn(),
  };
});

vi.mock('@meteora-ag/dynamic-bonding-curve-sdk', () => ({
  DynamicBondingCurveClient: vi.fn(() => ({
    state: { getPool: sdk.getPool, getPoolConfig: sdk.getPoolConfig },
    pool: { swapQuote2: sdk.swapQuote2, swap2: sdk.dbcSwap2 },
  })),
  getCurrentPoint: vi.fn(() => Promise.resolve(sdk.bn(1_000))),
  convertToLamports: (value: string) => sdk.bn(value),
  SwapMode: { ExactIn: 0, PartialFill: 1, ExactOut: 2 },
}));

vi.mock('@meteora-ag/cp-amm-sdk', () => ({
  CpAmm: vi.fn(() => ({
    fetchPoolState: sdk.fetchPoolState,
    getQuote2: sdk.getQuote2,
    swap2: sdk.dammSwap2,
  })),
  getCurrentPoint: vi.fn(() => Promise.resolve(sdk.bn(1_000))),
  getTokenProgram: vi.fn(),
  SwapMode: { ExactIn: 0, PartialFill: 1, ExactOut: 2 },
}));

// The shared vitest placeholder is not a valid public key; the pool check parses it.
const DBC_CONFIG = vi.hoisted(() => 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8');
vi.mock('../env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env')>();
  return { ...actual, env: { ...actual.env, VITE_DBC_CONFIG: DBC_CONFIG } };
});

vi.mock('@solana/wallet-adapter-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/wallet-adapter-react')>()),
  useWallet: vi.fn(),
  useConnection: vi.fn(),
}));

const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill));
const CONFIG = new PublicKey(DBC_CONFIG);
const OWNER = key(1);
const OTHER = key(4);
const SIG = 'swap-signature';
const CURVE_TARGET: TradeTarget = {
  phase: 'curve',
  pool: new PublicKey(CURVE_DBC_POOL),
  mint: new PublicKey(CURVE_MINT),
};
const DAMM_TARGET: TradeTarget = {
  phase: 'graduated',
  pool: new PublicKey(GRADUATED_DAMM_POOL),
  mint: new PublicKey(GRADUATED_MINT),
};

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

// Layout-encoded program instructions fail under jsdom; a stub instruction is enough.
function stubTx(): Promise<Transaction> {
  return Promise.resolve(
    new Transaction().add(
      new TransactionInstruction({ keys: [], programId: key(2), data: Buffer.from([1]) }),
    ),
  );
}

function connect(wallet: PublicKey | null) {
  const context: ConnectionContextState = { connection: connection as unknown as Connection };
  vi.mocked(useConnection).mockReturnValue(context);
  vi.mocked(useWallet).mockReturnValue({
    publicKey: wallet,
    connected: wallet !== null,
    signTransaction,
  } as unknown as WalletContextState);
}

function curvePool(overrides: Record<string, unknown> = {}) {
  return {
    poolState: {
      config: CONFIG,
      baseMint: new PublicKey(CURVE_MINT),
      sqrtPrice: sdk.bn(1_000_000),
      ...overrides,
    },
  };
}

function dammPool(overrides: Record<string, unknown> = {}) {
  return {
    activationType: 1,
    tokenAMint: new PublicKey(GRADUATED_MINT),
    tokenBMint: NATIVE_MINT,
    ...overrides,
  };
}

function curveQuote(amountOut: bigint, minOut: bigint) {
  return {
    outputAmount: sdk.bn(amountOut),
    minimumAmountOut: sdk.bn(minOut),
    nextSqrtPrice: sdk.bn(1_010_000),
  };
}

function dammQuote(amountOut: bigint, minOut: bigint) {
  return {
    outputAmount: sdk.bn(amountOut),
    minimumAmountOut: sdk.bn(minOut),
    priceImpact: { toString: () => '0.85' },
  };
}

function renderPanel(model = curveModel) {
  return render(
    <TestProviders>
      <TradePanel model={model} />
    </TestProviders>,
  );
}

function enterAmount(value: string) {
  fireEvent.change(screen.getByLabelText(/You (pay|sell)/), { target: { value } });
}

function quoteRow(label: string): string | null | undefined {
  return screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
}

beforeEach(() => {
  connect(null);
  sdk.getPoolConfig.mockResolvedValue({ activationType: 1 });
  sdk.dbcSwap2.mockImplementation(stubTx);
  sdk.dammSwap2.mockImplementation(stubTx);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('TradePanel', () => {
  it('quotes a curve buy with the DBC SDK', async () => {
    sdk.getPool.mockResolvedValue(curvePool());
    sdk.swapQuote2.mockReturnValue(curveQuote(35_000_000_000_000n, 34_650_000_000_000n));
    renderPanel();

    expect(screen.getByText('Meteora DBC')).toBeTruthy();
    enterAmount('1');
    expect(await screen.findByText('≈ 35,000,000 $LLAMA8')).toBeTruthy();
    expect(quoteRow('Minimum received')).toBe('34,650,000 $LLAMA8');
    expect(quoteRow('Price impact')).toBe('2.01%');

    const params = sdk.swapQuote2.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({ swapBaseForQuote: false, slippageBps: 100, swapMode: 1 });
    expect(String(params.amountIn)).toBe('1000000000');
    expect(screen.getByText(/0\.01 SOL/)).toBeTruthy();
  });

  it('quotes a graduated sell with cp-amm getQuote2 and slippage in percent', async () => {
    const mint = new PublicKey(GRADUATED_MINT);
    sdk.fetchPoolState.mockResolvedValue(dammPool());
    sdk.getQuote2.mockReturnValue(dammQuote(2_500_000_000n, 2_425_000_000n));
    renderPanel(graduatedModel);

    expect(screen.getByText('DAMM v2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    fireEvent.click(screen.getByRole('button', { name: '3%' }));
    enterAmount('1000');
    expect(await screen.findByText('≈ 2.5 SOL')).toBeTruthy();
    expect(quoteRow('Minimum received')).toBe('2.425 SOL');
    expect(quoteRow('Price impact')).toBe('0.85%');

    const params = sdk.getQuote2.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(params.slippage).toBe(3);
    expect((params.inputTokenMint as PublicKey).equals(mint)).toBe(true);
    expect(String(params.amountIn)).toBe('1000000000');
    expect(sdk.swapQuote2).not.toHaveBeenCalled();
  });

  it('disables trading with a hint when no wallet is connected', async () => {
    sdk.getPool.mockResolvedValue(curvePool({ sqrtPrice: sdk.bn(1) }));
    sdk.swapQuote2.mockReturnValue({ outputAmount: sdk.bn(5), nextSqrtPrice: sdk.bn(1) });
    renderPanel();

    enterAmount('0.5');
    await screen.findByText('Minimum received');
    expect(screen.getByText('Connect a wallet to trade.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Buy $LLAMA8' }).hasAttribute('disabled')).toBe(true);
  });

  it('disables trading when the token has no pool and never quotes', async () => {
    renderPanel(unlaunchedModel);

    expect(screen.getByText('Trading opens once this token has a live pool.')).toBeTruthy();
    expect(screen.getByLabelText('You pay').hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Buy $TOKEN' }).hasAttribute('disabled')).toBe(true);
    await waitFor(() => expect(sdk.getPool).not.toHaveBeenCalled());
  });

  it('flags an invalid amount without quoting', () => {
    renderPanel();
    enterAmount('0.0000000001');
    expect(screen.getByText(/at most 9 decimals/)).toBeTruthy();
    expect(sdk.swapQuote2).not.toHaveBeenCalled();
  });

  it('signs a curve buy for no less than the minimum the user was shown', async () => {
    connect(OWNER);
    sdk.getPool.mockResolvedValue(curvePool());
    sdk.swapQuote2.mockReturnValue(curveQuote(35_000_000_000_000n, 34_650_000_000_000n));
    renderPanel();
    enterAmount('1');
    await screen.findByText('≈ 35,000,000 $LLAMA8');

    // Slightly worse at signing time: still clears the shown minimum, but its own bound is looser.
    sdk.swapQuote2.mockReturnValue(curveQuote(34_900_000_000_000n, 34_551_000_000_000n));
    fireEvent.click(screen.getByRole('button', { name: 'Buy $LLAMA8' }));
    expect(await screen.findByText('Swap confirmed:')).toBeTruthy();

    const params = sdk.dbcSwap2.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({ swapBaseForQuote: false, swapMode: 1 });
    expect(String(params.amountIn)).toBe('1000000000');
    expect(String(params.minimumAmountOut)).toBe('34650000000000');
    expect(signTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps the fresh minimum on a graduated sell when it is the higher one', async () => {
    connect(OWNER);
    sdk.fetchPoolState.mockResolvedValue(dammPool());
    sdk.getQuote2.mockReturnValue(dammQuote(2_500_000_000n, 2_425_000_000n));
    renderPanel(graduatedModel);
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    enterAmount('1000');
    await screen.findByText('≈ 2.5 SOL');

    sdk.getQuote2.mockReturnValue(dammQuote(2_600_000_000n, 2_522_000_000n));
    fireEvent.click(screen.getByRole('button', { name: 'Sell $QCODE' }));
    expect(await screen.findByText('Swap confirmed:')).toBeTruthy();

    const params = sdk.dammSwap2.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((params.inputTokenMint as PublicKey).equals(new PublicKey(GRADUATED_MINT))).toBe(true);
    expect((params.outputTokenMint as PublicKey).equals(NATIVE_MINT)).toBe(true);
    expect(String(params.amountIn)).toBe('1000000000');
    expect(String(params.minimumAmountOut)).toBe('2522000000');
  });

  it.each([
    ['curve', curveModel, 'LLAMA8'],
    ['graduated', graduatedModel, 'QCODE'],
  ] as const)(
    'aborts a %s buy without signing when the fresh quote is below the minimum shown',
    async (_phase, model, symbol) => {
      connect(OWNER);
      sdk.getPool.mockResolvedValue(curvePool());
      sdk.fetchPoolState.mockResolvedValue(dammPool());
      sdk.swapQuote2.mockReturnValue(curveQuote(35_000_000_000_000n, 34_650_000_000_000n));
      sdk.getQuote2.mockReturnValue(dammQuote(35_000_000_000_000n, 34_650_000_000_000n));
      renderPanel(model);
      enterAmount('1');
      await screen.findByText(`≈ 35,000,000 $${symbol}`);

      sdk.swapQuote2.mockReturnValue(curveQuote(34_000_000_000_000n, 33_660_000_000_000n));
      sdk.getQuote2.mockReturnValue(dammQuote(34_000_000_000_000n, 33_660_000_000_000n));
      fireEvent.click(screen.getByRole('button', { name: `Buy $${symbol}` }));

      expect((await screen.findByRole('alert')).textContent).toMatch(
        /less than the minimum you were shown\. Check the new quote/,
      );
      expect(await screen.findByText(`≈ 34,000,000 $${symbol}`)).toBeTruthy();
      expect(sdk.dbcSwap2).not.toHaveBeenCalled();
      expect(sdk.dammSwap2).not.toHaveBeenCalled();
      expect(signTransaction).not.toHaveBeenCalled();
    },
  );

  it('refuses to quote a curve pool that is not on the platform config', async () => {
    sdk.getPool.mockResolvedValue(curvePool({ config: OTHER }));
    renderPanel();
    enterAmount('1');

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /not on the platform bonding curve config/,
    );
    expect(sdk.getPoolConfig).not.toHaveBeenCalled();
    expect(sdk.swapQuote2).not.toHaveBeenCalled();
  });

  it('aborts without signing when the pool stops matching the token before signing', async () => {
    connect(OWNER);
    sdk.getPool.mockResolvedValue(curvePool());
    sdk.swapQuote2.mockReturnValue(curveQuote(35_000_000_000_000n, 34_650_000_000_000n));
    renderPanel();
    enterAmount('1');
    await screen.findByText('≈ 35,000,000 $LLAMA8');

    sdk.getPool.mockResolvedValue(curvePool({ baseMint: OTHER }));
    fireEvent.click(screen.getByRole('button', { name: 'Buy $LLAMA8' }));

    expect((await screen.findAllByText(/base mint is not this token/)).length).toBeGreaterThan(0);
    expect(sdk.dbcSwap2).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
  });
});

describe('buildTradeTransaction pool checks', () => {
  const order = { side: 'buy', amountIn: 1_000_000_000n, slippageBps: 100, minOut: 1n } as const;
  const conn = connection as unknown as Connection;

  it('targets the API mint in both phases', () => {
    expect(tradeTarget(curveModel)).toEqual(CURVE_TARGET);
    expect(tradeTarget(graduatedModel)).toEqual(DAMM_TARGET);
  });

  it.each([
    ['another config', { config: OTHER }, /not on the platform bonding curve config/],
    ['another base mint', { baseMint: OTHER }, /base mint is not this token/],
  ])('refuses a curve pool with %s', async (_label, overrides, message) => {
    sdk.getPool.mockResolvedValue(curvePool(overrides));

    await expect(buildTradeTransaction(conn, OWNER, CURVE_TARGET, order)).rejects.toThrow(message);
    expect(sdk.swapQuote2).not.toHaveBeenCalled();
    expect(sdk.dbcSwap2).not.toHaveBeenCalled();
  });

  it.each([
    ['without the token', { tokenAMint: OTHER }],
    ['against a quote mint other than SOL', { tokenBMint: OTHER }],
  ])('refuses a DAMM v2 pool %s', async (_label, overrides) => {
    sdk.fetchPoolState.mockResolvedValue(dammPool(overrides));

    await expect(buildTradeTransaction(conn, OWNER, DAMM_TARGET, order)).rejects.toThrow(
      /does not pair this token with SOL/,
    );
    expect(sdk.getQuote2).not.toHaveBeenCalled();
    expect(sdk.dammSwap2).not.toHaveBeenCalled();
  });
});
