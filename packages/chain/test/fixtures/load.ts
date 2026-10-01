import { readFileSync } from 'node:fs';

import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';

/**
 * The JSON fixtures are hand-written in the shape `Connection.getParsedTransaction`
 * returns (`jsonParsed` encoding, web3.js 1.99 `ParsedTransactionWithMeta`):
 *
 * - `transaction.message.accountKeys[]`: `{ pubkey: PublicKey, signer, writable, source }`.
 * - `transaction.message.instructions[]` and `meta.innerInstructions[].instructions[]`
 *   are either `ParsedInstruction` `{ program, programId: PublicKey, parsed, stackHeight }`
 *   or `PartiallyDecodedInstruction` `{ programId: PublicKey, accounts: PublicKey[], data }`.
 * - spl-token `parsed` is `{ type: 'transfer', info: { source, destination, authority,
 *   amount } }` or `{ type: 'transferChecked', info: { source, destination, mint,
 *   authority, tokenAmount: { amount, decimals, uiAmount, uiAmountString } } }`,
 *   with every address a base58 string and amounts as decimal strings.
 * - spl-memo `parsed` is the memo text itself (a string).
 * - `meta.pre/postTokenBalances[]`: `{ accountIndex, mint, owner, programId, uiTokenAmount }`
 *   with string addresses.
 *
 * JSON cannot hold `PublicKey`, so the loader revives `pubkey`, instruction
 * `programId` and partially-decoded `accounts` back into `PublicKey` instances.
 */
export interface RawInstruction {
  program?: string;
  programId: string;
  parsed?: string | { type: string; info: Record<string, unknown> };
  accounts?: string[];
  data?: string;
  stackHeight: number | null;
}

export interface RawDepositTx {
  slot: number;
  transaction: {
    signatures: string[];
    message: { instructions: RawInstruction[] };
  };
  meta: {
    err: unknown;
    innerInstructions: { index: number; instructions: RawInstruction[] }[];
    postTokenBalances: { accountIndex: number; mint: string }[];
  };
}

export type FixtureName =
  'deposit-transfer-checked' | 'deposit-transfer-inner' | 'deposit-two-transfers';

const isInstruction = (holder: unknown) =>
  typeof holder === 'object' && holder !== null && 'stackHeight' in holder;

function revive(this: unknown, key: string, value: unknown): unknown {
  if (key === 'pubkey' && typeof value === 'string') return new PublicKey(value);
  if (key === 'programId' && typeof value === 'string' && isInstruction(this)) {
    return new PublicKey(value);
  }
  if (key === 'accounts' && Array.isArray(value) && isInstruction(this)) {
    const accounts: unknown[] = value;
    return accounts.map((a) => (typeof a === 'string' ? new PublicKey(a) : a));
  }
  return value;
}

export function loadDepositFixture(
  name: FixtureName,
  edit?: (raw: RawDepositTx) => void,
): ParsedTransactionWithMeta {
  const text = readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8');
  const raw = JSON.parse(text) as RawDepositTx;
  edit?.(raw);
  return JSON.parse(JSON.stringify(raw), revive) as ParsedTransactionWithMeta;
}
