import type { ParsedTransactionWithMeta, PublicKey, TokenBalance } from '@solana/web3.js';

import { NATIVE_MINT } from './sdk.js';

/** Amounts a landed swap actually moved, read from the tx's pre/post token balances (CHN-03). */
export interface SwapFill {
  /** Input base units the pool's input vault received (lamports for a SOL input). */
  amountIn: bigint;
  /** Output base units the owner received (lamports for a SOL output, from the vault). */
  amountOut: bigint;
}

export interface SwapFillAccounts {
  owner: PublicKey;
  inputVault: PublicKey;
  outputVault: PublicKey;
  outputMint: PublicKey;
}

const amountOf = (balances: TokenBalance[] | null | undefined, index: number): bigint => {
  const balance = balances?.find((b) => b.accountIndex === index);
  return balance ? BigInt(balance.uiTokenAmount.amount) : 0n;
};

/** post − pre of one token account; 0 when the tx does not list it. */
export function tokenAccountDelta(tx: ParsedTransactionWithMeta, account: PublicKey): bigint {
  const index = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.equals(account));
  if (index < 0) return 0n;
  return amountOf(tx.meta?.postTokenBalances, index) - amountOf(tx.meta?.preTokenBalances, index);
}

/** post − pre summed over every `mint` token account owned by `owner` (accounts created or closed count as 0). */
export function ownerTokenDelta(
  tx: ParsedTransactionWithMeta,
  owner: PublicKey,
  mint: PublicKey,
): bigint {
  const owner58 = owner.toBase58();
  const mint58 = mint.toBase58();
  const sum = (balances: TokenBalance[] | null | undefined) =>
    (balances ?? [])
      .filter((b) => b.owner === owner58 && b.mint === mint58)
      .reduce((total, b) => total + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
}

/**
 * The input is what the pool's input vault gained (a wrapped-SOL input account is opened
 * and closed in the same tx, so the owner side shows nothing); a token output is the
 * owner's balance gain, a SOL output is what the output vault lost. Null unless the tx
 * succeeded and both amounts are positive.
 */
export function parseSwapFill(
  tx: ParsedTransactionWithMeta | null,
  accounts: SwapFillAccounts,
): SwapFill | null {
  if (!tx?.meta || tx.meta.err !== null) return null;
  const amountIn = tokenAccountDelta(tx, accounts.inputVault);
  const amountOut = accounts.outputMint.equals(NATIVE_MINT)
    ? -tokenAccountDelta(tx, accounts.outputVault)
    : ownerTokenDelta(tx, accounts.owner, accounts.outputMint);
  return amountIn > 0n && amountOut > 0n ? { amountIn, amountOut } : null;
}

/** What a landed add-liquidity tx moved into each DAMM v2 vault; null unless it succeeded. */
export function parseLiquidityFill(
  tx: ParsedTransactionWithMeta | null,
  { tokenAVault, tokenBVault }: { tokenAVault: PublicKey; tokenBVault: PublicKey },
): { amountA: bigint; amountB: bigint } | null {
  if (!tx?.meta || tx.meta.err !== null) return null;
  const amountA = tokenAccountDelta(tx, tokenAVault);
  const amountB = tokenAccountDelta(tx, tokenBVault);
  return amountA >= 0n && amountB >= 0n ? { amountA, amountB } : null;
}
