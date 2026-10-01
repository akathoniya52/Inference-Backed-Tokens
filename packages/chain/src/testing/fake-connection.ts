import {
  type BlockhashWithExpiryBlockHeight,
  type BlockheightBasedTransactionConfirmationStrategy,
  type Commitment,
  Keypair,
  type RpcResponseAndContext,
  type SignatureResult,
  type SignatureStatus,
  type SimulatedTransactionResponse,
  type TransactionError,
  TransactionExpiredBlockheightExceededError,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

import type { SendConnection } from '../send.js';

/**
 * How the next `confirmTransaction` behaves:
 * - `confirmed`: the tx lands;
 * - `expired`: blockhash expiry, the tx never landed;
 * - `expired-landed`: blockhash expiry, but `getSignatureStatuses` reports it confirmed;
 * - an `Error`: thrown as-is (RPC failure).
 */
export type ConfirmOutcome = 'confirmed' | 'expired' | 'expired-landed' | Error;

export interface SentTx {
  signature: string;
  raw: Uint8Array;
}

const ctx = <T>(value: T): RpcResponseAndContext<T> => ({ context: { slot: 1 }, value });

/** In-memory `SendConnection` for `sendAndConfirm` tests; never touches the network. */
export class FakeConnection implements SendConnection {
  /** Ordered call log: `getLatestBlockhash`, `sendRawTransaction:<sig>`, `confirmTransaction:<sig>`, ... */
  readonly log: string[] = [];
  readonly blockhashes: BlockhashWithExpiryBlockHeight[] = [];
  readonly sent: SentTx[] = [];
  readonly confirmed: BlockheightBasedTransactionConfirmationStrategy[] = [];
  readonly landed = new Set<string>();
  simulationError: TransactionError | null = null;
  private readonly confirmQueue: ConfirmOutcome[] = [];
  private readonly sendErrors: Error[] = [];
  private height = 1000;

  queueConfirm(...outcomes: ConfirmOutcome[]): this {
    this.confirmQueue.push(...outcomes);
    return this;
  }

  queueSendError(...errors: Error[]): this {
    this.sendErrors.push(...errors);
    return this;
  }

  count(method: string): number {
    return this.log.filter((e) => e === method || e.startsWith(`${method}:`)).length;
  }

  getLatestBlockhash(_commitment?: Commitment): Promise<BlockhashWithExpiryBlockHeight> {
    this.log.push('getLatestBlockhash');
    this.height += 150;
    const latest = {
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: this.height,
    };
    this.blockhashes.push(latest);
    return Promise.resolve(latest);
  }

  sendRawTransaction(raw: Buffer | Uint8Array | number[]): Promise<string> {
    const bytes = Uint8Array.from(raw);
    const firstSig = VersionedTransaction.deserialize(bytes).signatures[0] ?? new Uint8Array(64);
    const signature = bs58.encode(firstSig);
    this.log.push(`sendRawTransaction:${signature}`);
    const error = this.sendErrors.shift();
    if (error) return Promise.reject(error);
    this.sent.push({ signature, raw: bytes });
    return Promise.resolve(signature);
  }

  confirmTransaction(
    strategy: BlockheightBasedTransactionConfirmationStrategy,
    _commitment?: Commitment,
  ): Promise<RpcResponseAndContext<SignatureResult>> {
    this.log.push(`confirmTransaction:${strategy.signature}`);
    this.confirmed.push(strategy);
    const outcome = this.confirmQueue.shift() ?? 'confirmed';
    if (outcome instanceof Error) return Promise.reject(outcome);
    if (outcome === 'confirmed') {
      this.landed.add(strategy.signature);
      return Promise.resolve(ctx({ err: null }));
    }
    if (outcome === 'expired-landed') this.landed.add(strategy.signature);
    return Promise.reject(new TransactionExpiredBlockheightExceededError(strategy.signature));
  }

  getSignatureStatuses(
    signatures: string[],
  ): Promise<RpcResponseAndContext<(SignatureStatus | null)[]>> {
    this.log.push('getSignatureStatuses');
    return Promise.resolve(
      ctx(
        signatures.map((s) =>
          this.landed.has(s)
            ? { slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' as const }
            : null,
        ),
      ),
    );
  }

  simulateTransaction(
    _tx: VersionedTransaction,
  ): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
    this.log.push('simulateTransaction');
    return Promise.resolve(ctx({ err: this.simulationError, logs: [] }));
  }
}
