import type { Model } from '@ibt/shared';
import {
  useConnection,
  useWallet,
  type ConnectionContextState,
  type WalletContextState,
} from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, TransactionInstruction, type Connection } from '@solana/web3.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { curveModel, GRADUATED_DAMM_POOL, graduatedModel } from '../fixtures/models';
import { resolveClaimRole } from '../lib/claims';
import { TestProviders } from '../test-utils';
import { ClaimFees, OwnerClaimFees } from './ClaimFees';

const sdk = vi.hoisted(() => ({
  getPool: vi.fn(),
  getPoolConfig: vi.fn(),
  claimCreatorTradingFee: vi.fn(),
  claimPartnerTradingFee: vi.fn(),
  fetchPoolState: vi.fn(),
  getUserPositionByPool: vi.fn(),
  claimPositionFee: vi.fn(),
}));

vi.mock('@meteora-ag/dynamic-bonding-curve-sdk', () => ({
  DynamicBondingCurveClient: vi.fn(() => ({
    state: { getPool: sdk.getPool, getPoolConfig: sdk.getPoolConfig },
    creator: { claimCreatorTradingFee: sdk.claimCreatorTradingFee },
    partner: { claimPartnerTradingFee: sdk.claimPartnerTradingFee },
  })),
  U64_MAX: 'u64-max',
}));

vi.mock('@meteora-ag/cp-amm-sdk', () => ({
  CpAmm: vi.fn(() => ({
    fetchPoolState: sdk.fetchPoolState,
    getUserPositionByPool: sdk.getUserPositionByPool,
    claimPositionFee: sdk.claimPositionFee,
  })),
  getTokenProgram: vi.fn(() => new PublicKey(new Uint8Array(32).fill(8))),
}));

vi.mock('@solana/wallet-adapter-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/wallet-adapter-react')>()),
  useWallet: vi.fn(),
  useConnection: vi.fn(),
}));

const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill));
const TREASURY = key(7);
const STRANGER = key(4);
const SIG = 'claim-signature';

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

function renderClaim(model: Model, Component = ClaimFees) {
  return render(
    <TestProviders>
      <Component model={model} />
    </TestProviders>,
  );
}

async function claim() {
  fireEvent.click(await screen.findByRole('button', { name: 'Claim fees' }));
  expect(await screen.findByText('Fees claimed:')).toBeTruthy();
}

beforeEach(() => {
  sdk.getPool.mockResolvedValue({ poolState: { config: key(3) } });
  sdk.getPoolConfig.mockResolvedValue({ feeClaimer: TREASURY });
  sdk.claimCreatorTradingFee.mockImplementation(stubTx);
  sdk.claimPartnerTradingFee.mockImplementation(stubTx);
  sdk.claimPositionFee.mockImplementation(stubTx);
  sdk.fetchPoolState.mockResolvedValue({
    tokenAMint: key(5),
    tokenBMint: key(6),
    tokenAVault: key(10),
    tokenBVault: key(11),
    tokenAFlag: 0,
    tokenBFlag: 0,
  });
  sdk.getUserPositionByPool.mockResolvedValue([
    { position: key(12), positionNftAccount: key(13), positionState: {} },
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveClaimRole', () => {
  it('picks creator for the provider, partner for the fee claimer, otherwise none', () => {
    expect(resolveClaimRole('a', 'a', 'b')).toBe('creator');
    expect(resolveClaimRole('b', 'a', 'b')).toBe('partner');
    expect(resolveClaimRole('c', 'a', 'b')).toBeNull();
    expect(resolveClaimRole('c', 'a', null)).toBeNull();
  });
});

describe('ClaimFees', () => {
  it('claims creator trading fees on the curve without touching the fee config', async () => {
    const owner = new PublicKey(curveModel.providerWallet);
    connect(owner);
    renderClaim(curveModel);

    expect(screen.getByText('Creator')).toBeTruthy();
    await claim();

    expect(sdk.claimCreatorTradingFee).toHaveBeenCalledTimes(1);
    const params = sdk.claimCreatorTradingFee.mock.calls[0]?.[0] as Record<string, PublicKey>;
    expect(params.creator?.equals(owner)).toBe(true);
    expect(params.pool?.toBase58()).toBe(curveModel.token.dbcPool);
    expect(sdk.claimPartnerTradingFee).not.toHaveBeenCalled();
    expect(sdk.claimPositionFee).not.toHaveBeenCalled();
    expect(sdk.getPoolConfig).not.toHaveBeenCalled();
  });

  it('adds claimPositionFee for each DAMM v2 position once graduated', async () => {
    const owner = new PublicKey(graduatedModel.providerWallet);
    connect(owner);
    renderClaim(graduatedModel);

    expect(screen.getByText('Fees on your locked DAMM v2 position')).toBeTruthy();
    await claim();

    expect(sdk.claimCreatorTradingFee).toHaveBeenCalledTimes(1);
    const pool = sdk.getUserPositionByPool.mock.calls[0]?.[0] as PublicKey | undefined;
    expect(pool?.toBase58()).toBe(GRADUATED_DAMM_POOL);
    expect(sdk.claimPositionFee).toHaveBeenCalledTimes(1);
    expect(sdk.claimPositionFee.mock.calls[0]?.[0]).toMatchObject({
      owner,
      position: key(12),
      positionNftAccount: key(13),
    });
    expect(sdk.claimPartnerTradingFee).not.toHaveBeenCalled();
  });

  it('claims partner trading fees for the treasury wallet', async () => {
    connect(TREASURY);
    renderClaim(graduatedModel);

    expect(await screen.findByText('Platform')).toBeTruthy();
    await claim();

    expect(sdk.claimPartnerTradingFee).toHaveBeenCalledTimes(1);
    const params = sdk.claimPartnerTradingFee.mock.calls[0]?.[0] as Record<string, PublicKey>;
    expect(params.feeClaimer?.equals(TREASURY)).toBe(true);
    expect(sdk.claimCreatorTradingFee).not.toHaveBeenCalled();
    expect(sdk.claimPositionFee).not.toHaveBeenCalled();
  });

  it('renders nothing for any other wallet', async () => {
    connect(STRANGER);
    const { container } = renderClaim(curveModel);
    await waitFor(() => expect(sdk.getPoolConfig).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('shows the token page variant to the provider only', () => {
    connect(TREASURY);
    const { container } = renderClaim(curveModel, OwnerClaimFees);
    expect(container.textContent).toBe('');
    expect(sdk.getPool).not.toHaveBeenCalled();
  });
});
