import { USDC_DECIMALS } from '@ibt/shared';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { PublicKey, TransactionInstruction } from '@solana/web3.js';

export function ataOf(owner: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true);
}

export function getOrCreateAtaIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): { ata: PublicKey; instruction: TransactionInstruction } {
  const ata = ataOf(owner, mint);
  return {
    ata,
    instruction: createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint),
  };
}

/** Idempotently creates the recipient's ATA (L176), then `transferChecked` with 6 decimals. */
export function usdcTransferIxs({
  usdcMint,
  from,
  toWallet,
  amount,
}: {
  usdcMint: PublicKey;
  from: PublicKey;
  toWallet: PublicKey;
  amount: bigint;
}): TransactionInstruction[] {
  const recipient = getOrCreateAtaIx(from, toWallet, usdcMint);
  return [
    recipient.instruction,
    createTransferCheckedInstruction(
      ataOf(from, usdcMint),
      usdcMint,
      recipient.ata,
      from,
      amount,
      USDC_DECIMALS,
    ),
  ];
}
