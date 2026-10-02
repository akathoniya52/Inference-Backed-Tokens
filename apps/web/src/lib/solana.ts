import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { USDC_DECIMALS } from '@ibt/shared';

import { env } from '../env';

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export function memoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, 'utf8'),
  });
}

export interface DepositTxInput {
  owner: PublicKey;
  amountMicro: bigint;
  depositRef: string;
}

/**
 * USDC `transferChecked` from the owner's ATA to the treasury ATA plus a memo
 * carrying `depositRef`, the shape the api's `parseDeposit` accepts (L491, L519).
 */
export function buildDepositTransaction({
  owner,
  amountMicro,
  depositRef,
}: DepositTxInput): Transaction {
  const mint = new PublicKey(env.VITE_USDC_MINT);
  const source = getAssociatedTokenAddressSync(mint, owner);
  return new Transaction().add(
    createTransferCheckedInstruction(
      source,
      mint,
      new PublicKey(env.VITE_TREASURY_USDC_ATA),
      owner,
      amountMicro,
      USDC_DECIMALS,
    ),
    memoInstruction(depositRef, owner),
  );
}
