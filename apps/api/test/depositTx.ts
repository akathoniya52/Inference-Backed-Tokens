import { randomBytes } from 'node:crypto';

import { ataOf, MEMO_PROGRAM_ID, USDC_MINT } from '@ibt/chain';
import type { FakeChain } from '@ibt/chain/testing';

import { base58Encode } from '../src/lib/base58.js';
import { toPublicKey } from '../src/lib/publicKey.js';

// `loadDepositFixture` reads JSON from the chain package's `test/` folder, which
// the installed workspace copy of `@ibt/chain` does not ship; build the same
// `jsonParsed` shape (G30) here instead.

type ParsedTx = Parameters<FakeChain['setParsedTx']>[1];

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export function randomSignature(): string {
  return base58Encode(randomBytes(64));
}

export interface DepositTxInput {
  signature: string;
  memo: string;
  treasuryWallet: string;
  amountMicro?: bigint;
}

export function buildDepositTx({
  signature,
  memo,
  treasuryWallet,
  amountMicro = 25_000_000n,
}: DepositTxInput): ParsedTx {
  const usdc = USDC_MINT.devnet;
  const payer = toPublicKey(base58Encode(randomBytes(32)));
  const destination = ataOf(toPublicKey(treasuryWallet), usdc);
  const source = ataOf(payer, usdc);
  return {
    slot: 412_345_678,
    blockTime: 1_790_900_000,
    version: 0,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [payer, source, destination].map((pubkey, i) => ({
          pubkey,
          signer: i === 0,
          writable: true,
          source: 'transaction' as const,
        })),
        recentBlockhash: base58Encode(randomBytes(32)),
        instructions: [
          { program: 'spl-memo', programId: MEMO_PROGRAM_ID, parsed: memo },
          {
            program: 'spl-token',
            programId: toPublicKey(TOKEN_PROGRAM),
            parsed: {
              type: 'transferChecked',
              info: {
                source: source.toBase58(),
                destination: destination.toBase58(),
                mint: usdc.toBase58(),
                authority: payer.toBase58(),
                tokenAmount: { amount: amountMicro.toString(), decimals: 6 },
              },
            },
          },
        ],
      },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      innerInstructions: [],
      postTokenBalances: [],
    },
  };
}
