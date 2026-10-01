import { PublicKey } from '@solana/web3.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { curveModel, GRADUATED_MINT, graduatedModel, unlaunchedModel } from '../fixtures/models';
import { NATIVE_MINT } from '../lib/trade';
import { TestProviders } from '../test-utils';
import { TradePanel } from './TradePanel';

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

const CONFIG = new PublicKey(new Uint8Array(32).fill(3));

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

afterEach(() => {
  vi.clearAllMocks();
});

describe('TradePanel', () => {
  it('quotes a curve buy with the DBC SDK', async () => {
    sdk.getPool.mockResolvedValue({ poolState: { config: CONFIG, sqrtPrice: sdk.bn(1_000_000) } });
    sdk.getPoolConfig.mockResolvedValue({ activationType: 1 });
    sdk.swapQuote2.mockReturnValue({
      outputAmount: sdk.bn(35_000_000_000_000n),
      minimumAmountOut: sdk.bn(34_650_000_000_000n),
      nextSqrtPrice: sdk.bn(1_010_000),
    });
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
    sdk.fetchPoolState.mockResolvedValue({
      activationType: 1,
      tokenAMint: mint,
      tokenBMint: NATIVE_MINT,
    });
    sdk.getQuote2.mockReturnValue({
      outputAmount: sdk.bn(2_500_000_000n),
      minimumAmountOut: sdk.bn(2_425_000_000n),
      priceImpact: { toString: () => '0.85' },
    });
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
    sdk.getPool.mockResolvedValue({ poolState: { config: CONFIG, sqrtPrice: sdk.bn(1) } });
    sdk.getPoolConfig.mockResolvedValue({ activationType: 1 });
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
});
