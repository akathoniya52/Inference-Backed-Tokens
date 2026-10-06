import { AppError } from '@ibt/shared';
import {
  type BlockhashWithExpiryBlockHeight,
  type BlockheightBasedTransactionConfirmationStrategy,
  type Commitment,
  type RpcResponseAndContext,
  type SendOptions,
  SendTransactionError,
  type SignatureResult,
  type SignatureStatus,
  type SignatureStatusConfig,
  type Signer,
  type SimulatedTransactionResponse,
  type SimulateTransactionConfig,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

export const DEFAULT_SEND_ATTEMPTS = 3;
/** Finalized-status checks after a blockhash expiry before giving up (`chain_send_failed`). */
export const DEFAULT_EXPIRY_CHECKS = 5;
/** Wait between those checks; finalization trails the tip by ~32 slots (~13 s). */
export const DEFAULT_EXPIRY_CHECK_MS = 4000;

/** Blocks a blockhash stays valid for (web3.js `lastValidBlockHeight` = its height + 150). */
export const BLOCKHASH_VALIDITY_BLOCKS = 150;

/**
 * Final status of a tx whose blockhash expired: `absent` means the node's history covers
 * the tx's whole validity window and has no record of it; `unknown` means it cannot tell
 * (expiry not finalized yet, status not finalized, or history pruned), so never resend.
 */
export type ExpiredSignatureState = 'landed' | 'failed' | 'absent' | 'unknown';

/** The reads `expiredSignatureStatus` needs, all answered by one node; `Connection` satisfies it. */
export interface ExpiryConnection {
  getBlockHeight(commitment?: Commitment): Promise<number>;
  getSignatureStatuses(
    signatures: string[],
    config?: SignatureStatusConfig,
  ): Promise<RpcResponseAndContext<(SignatureStatus | null)[]>>;
  getMinimumLedgerSlot(): Promise<number>;
}

/**
 * Re-check for a tx past `lastValidBlockHeight`, against finalized state and full history.
 * Pass a single node (not a load-balanced pool) so the ledger range and the status agree.
 * A tx valid until `lastValidBlockHeight` can only land in a slot above
 * `lastValidBlockHeight - 150` (a slot is never below its block height), so a node whose
 * ledger starts at or before that slot would have it if it landed.
 */
export async function expiredSignatureStatus(
  conn: ExpiryConnection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<ExpiredSignatureState> {
  if ((await conn.getBlockHeight('finalized')) <= lastValidBlockHeight) return 'unknown';
  const { value } = await conn.getSignatureStatuses([signature], {
    searchTransactionHistory: true,
  });
  const status = value[0];
  if (status) {
    if (status.confirmationStatus !== 'finalized') return 'unknown';
    return status.err === null ? 'landed' : 'failed';
  }
  const firstSlot = await conn.getMinimumLedgerSlot();
  return firstSlot <= lastValidBlockHeight - 2 * BLOCKHASH_VALIDITY_BLOCKS ? 'absent' : 'unknown';
}

/** The slice of `Connection` that `sendAndConfirm` needs; `Connection` satisfies it. */
export interface SendConnection extends ExpiryConnection {
  getLatestBlockhash(commitment?: Commitment): Promise<BlockhashWithExpiryBlockHeight>;
  sendRawTransaction(raw: Buffer | Uint8Array | number[], options?: SendOptions): Promise<string>;
  confirmTransaction(
    strategy: BlockheightBasedTransactionConfirmationStrategy,
    commitment?: Commitment,
  ): Promise<RpcResponseAndContext<SignatureResult>>;
  simulateTransaction(
    tx: VersionedTransaction,
    config?: SimulateTransactionConfig,
  ): Promise<RpcResponseAndContext<SimulatedTransactionResponse>>;
}

export type AnyTransaction = Transaction | VersionedTransaction;

/** Persist the signature before the tx can land (G20); throwing aborts the send. */
export type OnSigned = (signature: string, lastValidBlockHeight: number) => Promise<void> | void;

interface SendBase {
  connection: SendConnection;
  /** `signers[0]` pays the fee. */
  signers: Signer[];
  /** Co-signers such as position NFT keypairs. */
  extraSigners?: Signer[];
  onSigned?: OnSigned;
  simulate?: boolean;
  maxAttempts?: number;
  commitment: Commitment;
  /** Finalized-status checks after a blockhash expiry (default `DEFAULT_EXPIRY_CHECKS`). */
  expiryChecks?: number;
  /** Wait between those checks (default `DEFAULT_EXPIRY_CHECK_MS`). */
  expiryCheckMs?: number;
}

export type SendAndConfirmInput = SendBase &
  (
    | { tx: AnyTransaction; buildTx?: never }
    | { buildTx: () => AnyTransaction | Promise<AnyTransaction>; tx?: never }
  );

export interface SendResult {
  signature: string;
  landed: true;
  attempts: number;
}

class SimulationFailed extends Error {}

function signTx(
  tx: AnyTransaction,
  latest: BlockhashWithExpiryBlockHeight,
  signers: Signer[],
): { signature: string; raw: Uint8Array } {
  if (tx instanceof Transaction) {
    tx.recentBlockhash = latest.blockhash;
    tx.lastValidBlockHeight = latest.lastValidBlockHeight;
    tx.feePayer = signers[0]?.publicKey ?? tx.feePayer;
    tx.sign(...signers);
    if (!tx.signature) throw new Error('transaction has no fee-payer signature');
    return { signature: bs58.encode(tx.signature), raw: tx.serialize() };
  }
  tx.message.recentBlockhash = latest.blockhash;
  tx.sign(signers);
  const first = tx.signatures[0];
  if (!first) throw new Error('transaction has no fee-payer signature');
  return { signature: bs58.encode(first), raw: tx.serialize() };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `expiredSignatureStatus` (bounded) until it is decided or the checks run out. */
async function settleExpired(
  input: SendAndConfirmInput,
  signature: string,
  lastValidBlockHeight: number,
): Promise<ExpiredSignatureState> {
  const checks = Math.max(1, input.expiryChecks ?? DEFAULT_EXPIRY_CHECKS);
  const waitMs = input.expiryCheckMs ?? DEFAULT_EXPIRY_CHECK_MS;
  for (let check = 1; ; check++) {
    const state = await expiredSignatureStatus(input.connection, signature, lastValidBlockHeight);
    if (state !== 'unknown' || check >= checks) return state;
    await sleep(waitMs);
  }
}

/** Outcome unknown: the caller must resolve `signature` (e.g. `expiredSignatureStatus`) first. */
function unresolved(signature: string, lastValidBlockHeight: number, cause: unknown): AppError {
  return new AppError('chain_send_failed', {
    message: 'send outcome unknown; resolve the persisted signature before retrying',
    details: { signature, lastValidBlockHeight },
    cause,
  });
}

/** Landed with an on-chain error: re-sending the same instructions cannot succeed. */
function failedOnChain(signature: string, cause: unknown): AppError {
  return new AppError('chain_send_failed', {
    message: 'transaction failed on-chain',
    details: { signature, landed: true },
    cause,
  });
}

/**
 * Sends with a fresh blockhash per attempt and never re-sends a transaction
 * that already landed (Plan.md L258). `onSigned` is awaited before every
 * `sendRawTransaction`; if it throws, nothing is sent.
 *
 * A new attempt is only made when the previous one is provably dead: the
 * blockhash expired and `expiredSignatureStatus` (finalized height past
 * `lastValidBlockHeight`, finalized status or a ledger covering the whole
 * validity window) finds it `absent`, or the RPC rejected the send
 * (`SendTransactionError`, nothing forwarded), or the tx landed with an
 * on-chain error and `buildTx` can re-quote it. An expired tx still `unknown`
 * after `expiryChecks` polls, and anything else (network error, timeout, proxy
 * 5xx) may have reached the cluster, so the call fails with `chain_send_failed`
 * carrying `details.signature`/`details.lastValidBlockHeight`, and the caller
 * must resolve that signature first (keeper: `pendingTx`). A fixed `tx` that
 * failed on-chain is not re-sent (`chain_send_failed`, `details.landed: true`).
 */
export async function sendAndConfirm(input: SendAndConfirmInput): Promise<SendResult> {
  const { connection, commitment } = input;
  const maxAttempts = input.maxAttempts ?? DEFAULT_SEND_ATTEMPTS;
  const signers = [...input.signers, ...(input.extraSigners ?? [])];
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tx = input.buildTx ? await input.buildTx() : input.tx;
    const latest = await connection.getLatestBlockhash(commitment);
    const { signature, raw } = signTx(tx, latest, signers);

    if (input.simulate) {
      const sim = await connection.simulateTransaction(VersionedTransaction.deserialize(raw), {
        commitment,
        sigVerify: false,
      });
      if (sim.value.err !== null) {
        throw new AppError('chain_send_failed', {
          message: 'transaction simulation failed',
          cause: new SimulationFailed(JSON.stringify(sim.value.err)),
        });
      }
    }

    await input.onSigned?.(signature, latest.lastValidBlockHeight);

    try {
      await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
      const { value } = await connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        commitment,
      );
      if (value.err === null) return { signature, landed: true, attempts: attempt };
      lastError = new Error(`transaction failed: ${JSON.stringify(value.err)}`);
      if (!input.buildTx) throw failedOnChain(signature, lastError);
    } catch (err) {
      if (err instanceof AppError) throw err;
      lastError = err;
      if (err instanceof TransactionExpiredBlockheightExceededError) {
        const state = await settleExpired(input, signature, latest.lastValidBlockHeight);
        if (state === 'landed') return { signature, landed: true, attempts: attempt };
        if (state === 'absent') continue;
        if (state === 'failed') {
          if (!input.buildTx) throw failedOnChain(signature, err);
          continue;
        }
        throw unresolved(signature, latest.lastValidBlockHeight, err);
      }
      // The RPC answered the send with an error, so nothing was forwarded: safe to re-sign.
      if (err instanceof SendTransactionError) continue;
      // Not provably dropped: the tx may still land. Never re-sign here (L258).
      throw unresolved(signature, latest.lastValidBlockHeight, err);
    }
  }

  throw new AppError('chain_send_failed', { cause: lastError });
}
