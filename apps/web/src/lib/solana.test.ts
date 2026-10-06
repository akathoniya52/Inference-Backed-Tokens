// @vitest-environment node
import { USDC_MINT } from '@ibt/shared';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDepositTransaction, resolveTreasuryUsdcAta, TreasuryConfigError } from './solana';

const TREASURY = new PublicKey(new Uint8Array(32).fill(7));
const DERIVED_ATA = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT.devnet), TREASURY, true);
const DBC_CONFIG = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

const { getPoolConfig, testEnv } = vi.hoisted(() => ({
  getPoolConfig: vi.fn(),
  testEnv: { ata: '', mint: '' },
}));

vi.mock('@meteora-ag/dynamic-bonding-curve-sdk', () => ({
  DynamicBondingCurveClient: vi.fn(() => ({ state: { getPoolConfig } })),
}));

vi.mock('../env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      VITE_DBC_CONFIG: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
      get VITE_TREASURY_USDC_ATA() {
        return testEnv.ata;
      },
      get VITE_USDC_MINT() {
        return testEnv.mint;
      },
    },
  };
});

const connection = {} as Connection;

function configure(ata: string, mint: string = USDC_MINT.devnet) {
  testEnv.ata = ata;
  testEnv.mint = mint;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveTreasuryUsdcAta (INF-05)', () => {
  it("derives the deposit address from the config's fee claimer and USDC", async () => {
    configure(DERIVED_ATA.toBase58());
    getPoolConfig.mockResolvedValue({ feeClaimer: TREASURY });

    const ata = await resolveTreasuryUsdcAta(connection);
    expect(ata.equals(DERIVED_ATA)).toBe(true);
    expect((getPoolConfig.mock.calls[0]?.[0] as PublicKey).toBase58()).toBe(DBC_CONFIG);
  });

  it('refuses a configured ATA that is not the treasury USDC account', async () => {
    configure(new PublicKey(new Uint8Array(32).fill(3)).toBase58());
    getPoolConfig.mockResolvedValue({ feeClaimer: TREASURY });

    const failure = resolveTreasuryUsdcAta(connection);
    await expect(failure).rejects.toBeInstanceOf(TreasuryConfigError);
    await expect(failure).rejects.toThrow(DERIVED_ATA.toBase58());
  });

  it('refuses a USDC mint the api would not credit', async () => {
    configure(DERIVED_ATA.toBase58(), USDC_MINT['mainnet-beta']);
    getPoolConfig.mockResolvedValue({ feeClaimer: TREASURY });

    await expect(resolveTreasuryUsdcAta(connection)).rejects.toThrow(/VITE_USDC_MINT/);
    expect(getPoolConfig).not.toHaveBeenCalled();
  });

  it('refuses when the platform config is missing', async () => {
    configure(DERIVED_ATA.toBase58());
    getPoolConfig.mockResolvedValue(null);

    await expect(resolveTreasuryUsdcAta(connection)).rejects.toThrow(/config was not found/);
  });

  it('sends the transfer to the resolved account', () => {
    configure(DERIVED_ATA.toBase58());
    const tx = buildDepositTransaction({
      owner: Keypair.generate().publicKey,
      amountMicro: 1_000_000n,
      depositRef: 'AB12CD34',
      treasuryAta: DERIVED_ATA,
    });
    const transfer = tx.instructions[0];
    expect(transfer?.keys[2]?.pubkey.equals(DERIVED_ATA)).toBe(true);
  });
});
