import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, Transaction, TransactionInstruction, type Connection } from '@solana/web3.js';
import { USDC_DECIMALS, USDC_MINT } from '@ibt/shared';

import { env } from '../env';

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/** `null` instead of a throw for an address from the API that is not a public key. */
export function parsePublicKey(value: string | null): PublicKey | null {
  if (value === null) return null;
  try {
    return new PublicKey(value);
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

export function memoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, 'utf8'),
  });
}

export class TreasuryConfigError extends Error {
  constructor(message: string) {
    super(`Deposits are disabled: ${message} Nothing was sent; please contact the operator.`);
    this.name = 'TreasuryConfigError';
  }
}

/** The api credits `USDC_MINT[CLUSTER]` only, so any other configured mint is refused. */
export function depositUsdcMint(): PublicKey {
  const expected = USDC_MINT[env.VITE_CLUSTER];
  if (env.VITE_USDC_MINT !== expected) {
    throw new TreasuryConfigError(`VITE_USDC_MINT is not the ${env.VITE_CLUSTER} USDC mint.`);
  }
  return new PublicKey(expected);
}

/**
 * INF-05: the api credits transfers to `ata(TREASURY_WALLET, USDC_MINT)`, and
 * the treasury wallet is the platform DBC config's `feeClaimer`. The deposit
 * address is derived from that on-chain anchor; `VITE_TREASURY_USDC_ATA` must
 * equal it or deposits are refused, so a typo can never send USDC elsewhere.
 */
export async function resolveTreasuryUsdcAta(connection: Connection): Promise<PublicKey> {
  const mint = depositUsdcMint();
  const config = await new DynamicBondingCurveClient(connection, 'confirmed').state.getPoolConfig(
    new PublicKey(env.VITE_DBC_CONFIG),
  );
  if (!config) throw new TreasuryConfigError('the platform bonding curve config was not found.');
  const derived = getAssociatedTokenAddressSync(mint, config.feeClaimer, true);
  if (derived.toBase58() !== env.VITE_TREASURY_USDC_ATA) {
    throw new TreasuryConfigError(
      `VITE_TREASURY_USDC_ATA is not the treasury's USDC account (expected ${derived.toBase58()}).`,
    );
  }
  return derived;
}

export interface DepositTxInput {
  owner: PublicKey;
  amountMicro: bigint;
  depositRef: string;
  /** From `resolveTreasuryUsdcAta`, never straight from the env. */
  treasuryAta: PublicKey;
}

/**
 * USDC `transferChecked` from the owner's ATA to the treasury ATA plus a memo
 * carrying `depositRef`, the shape the api's `parseDeposit` accepts (L491, L519).
 */
export function buildDepositTransaction({
  owner,
  amountMicro,
  depositRef,
  treasuryAta,
}: DepositTxInput): Transaction {
  const mint = depositUsdcMint();
  const source = getAssociatedTokenAddressSync(mint, owner);
  return new Transaction().add(
    createTransferCheckedInstruction(source, mint, treasuryAta, owner, amountMicro, USDC_DECIMALS),
    memoInstruction(depositRef, owner),
  );
}
