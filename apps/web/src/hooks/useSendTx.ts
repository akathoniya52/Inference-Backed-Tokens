import { WalletError } from '@solana/wallet-adapter-base';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  Transaction,
  TransactionExpiredBlockheightExceededError,
  type Connection,
  type PublicKey,
  type VersionedTransaction,
} from '@solana/web3.js';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import { isApiError } from '../lib/api';

export type SendTxStatus =
  'idle' | 'building' | 'signing' | 'sending' | 'confirming' | 'confirmed' | 'failed';

export type SendTxErrorCode =
  | 'wallet_rejected'
  | 'slippage'
  | 'blockhash_expired'
  | 'insufficient_sol'
  | 'insufficient_funds'
  | 'account_not_found'
  | 'simulation_failed'
  | 'transaction_failed'
  | 'unknown';

export interface SendTxError {
  code: SendTxErrorCode;
  message: string;
}

export interface BuildContext {
  connection: Connection;
  payer: PublicKey;
  /** Use these for the transaction; confirmation waits on the same pair. */
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface SendTxRequest<T> {
  build: (ctx: BuildContext) => Promise<Transaction | VersionedTransaction>;
  /** Runs as soon as the transaction is sent, before confirmation. */
  onSent?: (signature: string) => void;
  onConfirmed?: (signature: string) => Promise<T> | T;
  /** Query keys to invalidate after `onConfirmed`; every query when omitted. */
  invalidate?: readonly QueryKey[];
}

export type SendTxOutcome<T> =
  | { ok: true; signature: string; result: T | undefined }
  | { ok: false; signature: string | null; error: SendTxError };

const MESSAGES: Record<Exclude<SendTxErrorCode, 'unknown'>, string> = {
  wallet_rejected: 'You rejected the request in your wallet.',
  slippage: 'The price moved beyond your slippage tolerance. Try again or raise the slippage.',
  blockhash_expired: 'The transaction expired before it was confirmed. Please try again.',
  insufficient_sol: 'Not enough SOL to pay for this transaction and its fees.',
  insufficient_funds: 'Your wallet does not hold enough of this token for that amount.',
  account_not_found:
    'A required account does not exist on-chain. If this wallet is new, fund it with SOL first; otherwise reload and try again.',
  simulation_failed:
    'The transaction would fail, so it was not sent. Check the amount and your balances, then try again.',
  transaction_failed:
    'The transaction failed on-chain. Only the network fee was charged; please try again.',
};

class TransactionFailedError extends Error {
  constructor(readonly detail: string) {
    super(`Transaction failed: ${detail}`);
    this.name = 'TransactionFailedError';
  }
}

class SimulationError extends Error {
  constructor(
    message: string,
    readonly logs: readonly string[],
  ) {
    super(message);
    this.name = 'SimulationError';
  }
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  if (error instanceof SimulationError) parts.push(...error.logs);
  if ('logs' in error && Array.isArray(error.logs)) parts.push(...error.logs.map(String));
  if (error instanceof WalletError && error.error instanceof Error) parts.push(error.error.message);
  return parts.join('\n');
}

function isWalletRejection(error: unknown, text: string): boolean {
  const walletLike =
    error instanceof WalletError || (error instanceof Error && /^Wallet/.test(error.name));
  if (!walletLike) return false;
  const inner: unknown = error instanceof WalletError ? error.error : undefined;
  const code =
    typeof inner === 'object' && inner !== null && 'code' in inner ? inner.code : undefined;
  return code === 4001 || /reject|denied|declined|cancel/i.test(text);
}

/** Maps wallet, RPC and program failures to a code plus a plain message (spec L503). */
export function mapSendTxError(error: unknown): SendTxError {
  const text = errorText(error);
  if (isWalletRejection(error, text))
    return { code: 'wallet_rejected', message: MESSAGES.wallet_rejected };
  if (
    error instanceof TransactionExpiredBlockheightExceededError ||
    /blockhash not found|block height exceeded/i.test(text)
  ) {
    return { code: 'blockhash_expired', message: MESSAGES.blockhash_expired };
  }
  if (/slippage|0x1771/i.test(text)) return { code: 'slippage', message: MESSAGES.slippage };
  if (/insufficient (lamports|funds for)|no record of a prior credit/i.test(text)) {
    return { code: 'insufficient_sol', message: MESSAGES.insufficient_sol };
  }
  // SPL Token's InsufficientFunds is custom error 1 (`0x1`); System's is a lamports message above.
  if (
    /Error: insufficient funds|custom program error: 0x1\b|"Custom":1\}/i.test(text) ||
    /\bCustom: ?1\b/.test(text)
  ) {
    return { code: 'insufficient_funds', message: MESSAGES.insufficient_funds };
  }
  if (/AccountNotFound|account not found/i.test(text)) {
    return { code: 'account_not_found', message: MESSAGES.account_not_found };
  }
  if (isApiError(error)) return { code: 'unknown', message: error.message };
  if (error instanceof SimulationError) {
    return { code: 'simulation_failed', message: MESSAGES.simulation_failed };
  }
  if (error instanceof TransactionFailedError) {
    return { code: 'transaction_failed', message: MESSAGES.transaction_failed };
  }
  const message =
    error instanceof Error && error.message ? error.message : 'The transaction failed.';
  return { code: 'unknown', message };
}

async function simulate(connection: Connection, tx: Transaction | VersionedTransaction) {
  const { value } =
    tx instanceof Transaction
      ? await connection.simulateTransaction(tx)
      : await connection.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
        });
  if (value.err !== null) {
    throw new SimulationError(`Simulation failed: ${JSON.stringify(value.err)}`, value.logs ?? []);
  }
}

export interface UseSendTx {
  send: <T = void>(request: SendTxRequest<T>) => Promise<SendTxOutcome<T>>;
  status: SendTxStatus;
  signature: string | null;
  error: SendTxError | null;
  reset: () => void;
}

/**
 * The single transaction path (spec L503): build → simulate → sign → send →
 * confirm with `lastValidBlockHeight` → `onConfirmed` → invalidate queries.
 * `send` never throws; failures come back as `{ok: false, error}`.
 */
export function useSendTx(): UseSendTx {
  const { connection } = useConnection();
  const { publicKey, signTransaction, sendTransaction } = useWallet();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SendTxStatus>('idle');
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<SendTxError | null>(null);
  const busy = useRef(false);

  const reset = useCallback(() => {
    setStatus('idle');
    setSignature(null);
    setError(null);
  }, []);

  const send = useCallback(
    async <T>(request: SendTxRequest<T>): Promise<SendTxOutcome<T>> => {
      if (busy.current) {
        return {
          ok: false,
          signature: null,
          error: { code: 'unknown', message: 'Another transaction is in progress.' },
        };
      }
      busy.current = true;
      setSignature(null);
      setError(null);
      let sent: string | null = null;
      try {
        if (!publicKey) throw new Error('Connect a wallet first.');
        setStatus('building');
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash('confirmed');
        const tx = await request.build({
          connection,
          payer: publicKey,
          blockhash,
          lastValidBlockHeight,
        });
        if (tx instanceof Transaction) {
          tx.feePayer ??= publicKey;
          tx.recentBlockhash ??= blockhash;
        }
        await simulate(connection, tx);

        setStatus('signing');
        if (signTransaction) {
          const signed = await signTransaction(tx);
          setStatus('sending');
          sent = await connection.sendRawTransaction(signed.serialize());
        } else {
          sent = await sendTransaction(tx, connection);
          setStatus('sending');
        }
        setSignature(sent);
        request.onSent?.(sent);

        setStatus('confirming');
        const { value } = await connection.confirmTransaction(
          { signature: sent, blockhash, lastValidBlockHeight },
          'confirmed',
        );
        if (value.err !== null) {
          throw new TransactionFailedError(JSON.stringify(value.err));
        }

        const result = request.onConfirmed ? await request.onConfirmed(sent) : undefined;
        if (request.invalidate) {
          await Promise.all(
            request.invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
          );
        } else {
          await queryClient.invalidateQueries();
        }
        setStatus('confirmed');
        return { ok: true, signature: sent, result };
      } catch (cause) {
        const mapped = mapSendTxError(cause);
        setError(mapped);
        setStatus('failed');
        return { ok: false, signature: sent, error: mapped };
      } finally {
        busy.current = false;
      }
    },
    [connection, publicKey, queryClient, sendTransaction, signTransaction],
  );

  return { send, status, signature, error, reset };
}
