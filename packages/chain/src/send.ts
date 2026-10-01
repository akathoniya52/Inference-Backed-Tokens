import { AppError } from '@ibt/shared';
import {
  type BlockhashWithExpiryBlockHeight,
  type BlockheightBasedTransactionConfirmationStrategy,
  type Commitment,
  type RpcResponseAndContext,
  type SendOptions,
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

/** The slice of `Connection` that `sendAndConfirm` needs; `Connection` satisfies it. */
export interface SendConnection {
  getLatestBlockhash(commitment?: Commitment): Promise<BlockhashWithExpiryBlockHeight>;
  sendRawTransaction(raw: Buffer | Uint8Array | number[], options?: SendOptions): Promise<string>;
  confirmTransaction(
    strategy: BlockheightBasedTransactionConfirmationStrategy,
    commitment?: Commitment,
  ): Promise<RpcResponseAndContext<SignatureResult>>;
  getSignatureStatuses(
    signatures: string[],
    config?: SignatureStatusConfig,
  ): Promise<RpcResponseAndContext<(SignatureStatus | null)[]>>;
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

async function hasLanded(
  connection: SendConnection,
  signature: string,
  commitment: Commitment,
): Promise<boolean> {
  const { value } = await connection.getSignatureStatuses([signature], {
    searchTransactionHistory: true,
  });
  const status = value[0];
  if (!status || status.err !== null) return false;
  return commitment === 'processed' || status.confirmationStatus !== 'processed';
}

/**
 * Sends with a fresh blockhash per attempt and never re-sends a transaction
 * that already landed (Plan.md L258). `onSigned` is awaited before every
 * `sendRawTransaction`; if it throws, nothing is sent.
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
    } catch (err) {
      lastError = err;
      if (err instanceof TransactionExpiredBlockheightExceededError) {
        if (await hasLanded(connection, signature, commitment)) {
          return { signature, landed: true, attempts: attempt };
        }
      }
    }
  }

  throw new AppError('chain_send_failed', { cause: lastError });
}
