import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type {
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  PublicKey,
  TransactionConfirmationStatus,
} from '@solana/web3.js';

import { MEMO_PROGRAM_ID } from './sdk.js';

const MEMO_V1_PROGRAM_ID = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVCDwQDzPHFJ';
const MEMO_PROGRAMS = new Set([MEMO_PROGRAM_ID.toBase58(), MEMO_V1_PROGRAM_ID]);

export interface DepositExpectation {
  usdcMint: PublicKey;
  treasuryAta: PublicKey;
  depositRef: string;
  /** Commitment the transaction was fetched or confirmed at; only `finalized` is accepted (L519). */
  confirmationStatus: TransactionConfirmationStatus | null | undefined;
}

export type DepositRejection =
  | 'tx_not_found'
  | 'not_finalized'
  | 'tx_failed'
  | 'missing_memo'
  | 'memo_mismatch'
  | 'wrong_destination'
  | 'wrong_mint'
  | 'zero_amount';

export type DepositResult =
  | {
      ok: true;
      amountMicro: bigint;
      /** Wallet that authorised the first counted transfer. */
      from: string;
      memo: string;
      slot: number;
      signature: string;
    }
  | { ok: false; reason: DepositRejection };

interface TokenTransfer {
  destination: string;
  authority: string;
  amount: bigint;
  /** Present for `transferChecked`; plain `transfer` resolves it from `postTokenBalances`. */
  mint: string | null;
}

type AnyInstruction = ParsedInstruction | PartiallyDecodedInstruction;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const amountOf = (v: unknown): bigint | null =>
  typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null;

function allInstructions(tx: ParsedTransactionWithMeta): AnyInstruction[] {
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions);
  return [...tx.transaction.message.instructions, ...inner];
}

function memoOf(ix: AnyInstruction): string | null {
  if (!('parsed' in ix) || !MEMO_PROGRAMS.has(ix.programId.toBase58())) return null;
  const parsed: unknown = ix.parsed;
  return str(parsed);
}

function tokenTransferOf(ix: AnyInstruction): TokenTransfer | null {
  if (!('parsed' in ix) || !ix.programId.equals(TOKEN_PROGRAM_ID)) return null;
  const parsed: unknown = ix.parsed;
  if (!isRecord(parsed) || !isRecord(parsed.info)) return null;
  const { info } = parsed;
  const destination = str(info.destination);
  const authority = str(info.authority) ?? str(info.multisigAuthority);
  if (!destination || !authority) return null;

  if (parsed.type === 'transfer') {
    const amount = amountOf(info.amount);
    return amount === null ? null : { destination, authority, amount, mint: null };
  }
  if (parsed.type === 'transferChecked' && isRecord(info.tokenAmount)) {
    const amount = amountOf(info.tokenAmount.amount);
    const mint = str(info.mint);
    return amount === null || !mint ? null : { destination, authority, amount, mint };
  }
  return null;
}

function postBalanceMint(tx: ParsedTransactionWithMeta, account: string): string | null {
  const keys = tx.transaction.message.accountKeys;
  const index = keys.findIndex((k) => k.pubkey.toBase58() === account);
  const balance = tx.meta?.postTokenBalances?.find((b) => b.accountIndex === index);
  return index >= 0 && balance ? balance.mint : null;
}

/**
 * Verifies a USDC deposit (Plan.md L519) from a `jsonParsed` transaction fetched
 * at `finalized`. Counts SPL Token `transfer`/`transferChecked` instructions,
 * top-level or inner, whose destination is the treasury ATA; the amount always
 * comes from those instructions, never from the client.
 */
export function parseDeposit(
  tx: ParsedTransactionWithMeta | null,
  expected: DepositExpectation,
): DepositResult {
  if (!tx) return { ok: false, reason: 'tx_not_found' };
  if (expected.confirmationStatus !== 'finalized') return { ok: false, reason: 'not_finalized' };
  if (!tx.meta || tx.meta.err !== null) return { ok: false, reason: 'tx_failed' };

  const instructions = allInstructions(tx);
  const memos = instructions.map(memoOf).filter((m): m is string => m !== null);
  if (memos.length === 0) return { ok: false, reason: 'missing_memo' };
  if (!memos.includes(expected.depositRef)) return { ok: false, reason: 'memo_mismatch' };

  const treasury = expected.treasuryAta.toBase58();
  const transfers = instructions
    .map(tokenTransferOf)
    .filter((t): t is TokenTransfer => t !== null && t.destination === treasury);
  const [first] = transfers;
  if (!first) return { ok: false, reason: 'wrong_destination' };

  const usdc = expected.usdcMint.toBase58();
  const allUsdc = transfers.every((t) => (t.mint ?? postBalanceMint(tx, t.destination)) === usdc);
  if (!allUsdc) return { ok: false, reason: 'wrong_mint' };

  const amountMicro = transfers.reduce((sum, t) => sum + t.amount, 0n);
  if (amountMicro === 0n) return { ok: false, reason: 'zero_amount' };

  return {
    ok: true,
    amountMicro,
    from: first.authority,
    memo: expected.depositRef,
    slot: tx.slot,
    signature: tx.transaction.signatures[0] ?? '',
  };
}
