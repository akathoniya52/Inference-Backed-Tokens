import {
  type Commitment,
  Connection,
  type Finality,
  type ParsedTransactionWithMeta,
  type PublicKey,
} from '@solana/web3.js';

/** RPC error backoff from Plan.md L259: wait 500 ms, 2 s, 8 s between attempts. */
export const RPC_BACKOFF_MS = [500, 2000, 8000] as const;
/** Attempts on the primary before every further attempt goes to the fallback. */
export const PRIMARY_ATTEMPTS = 2;

export type ReadConnection = Pick<
  Connection,
  | 'getParsedTransaction'
  | 'getSignatureStatuses'
  | 'getLatestBlockhash'
  | 'getBlockHeight'
  | 'getBalance'
  | 'getAccountInfo'
  | 'getTokenAccountBalance'
>;

export interface RpcOptions {
  rpcUrl: string;
  fallbackUrl?: string;
  commitment?: Commitment;
  /** Return false to fail immediately (e.g. a malformed request). Default: retry everything. */
  isRetryable?: (err: unknown) => boolean;
}

export interface RpcOptionsWithFactory<C extends ReadConnection> extends RpcOptions {
  createConnection: (url: string, commitment: Commitment) => C;
}

export interface RpcReads {
  getParsedTransaction(
    signature: string,
    finality?: Finality,
  ): Promise<ParsedTransactionWithMeta | null>;
  getSignatureStatuses: ReadConnection['getSignatureStatuses'];
  getLatestBlockhash(): ReturnType<ReadConnection['getLatestBlockhash']>;
  getBlockHeight(): Promise<number>;
  getBalance(address: PublicKey): Promise<number>;
  getAccountInfo(address: PublicKey): ReturnType<ReadConnection['getAccountInfo']>;
  getTokenAccountBalance(address: PublicKey): ReturnType<ReadConnection['getTokenAccountBalance']>;
}

export interface Rpc<C extends ReadConnection> {
  primary: C;
  fallback: C | null;
  commitment: Commitment;
  /**
   * Runs `fn` up to 4 times: attempts 1–2 on the primary, 3–4 on the fallback
   * (or the primary when none is configured), sleeping 500/2000/8000 ms in
   * between. Only for idempotent reads; never wrap a `sendRawTransaction`.
   */
  withRetry<T>(fn: (conn: C, attempt: number) => Promise<T>): Promise<T>;
  read: RpcReads;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createRpc(opts: RpcOptions): Rpc<Connection>;
export function createRpc<C extends ReadConnection>(opts: RpcOptionsWithFactory<C>): Rpc<C>;
export function createRpc(
  opts: RpcOptions & { createConnection?: (url: string, commitment: Commitment) => ReadConnection },
): Rpc<ReadConnection> {
  const commitment = opts.commitment ?? 'confirmed';
  const make = opts.createConnection ?? ((url, c) => new Connection(url, c));
  const isRetryable = opts.isRetryable ?? (() => true);
  const primary = make(opts.rpcUrl, commitment);
  const fallback = opts.fallbackUrl ? make(opts.fallbackUrl, commitment) : null;
  const finality: Finality = commitment === 'finalized' ? 'finalized' : 'confirmed';

  async function withRetry<T>(fn: (conn: ReadConnection, attempt: number) => Promise<T>) {
    const maxAttempts = RPC_BACKOFF_MS.length + 1;
    for (let attempt = 1; ; attempt++) {
      const conn = attempt > PRIMARY_ATTEMPTS && fallback ? fallback : primary;
      try {
        return await fn(conn, attempt);
      } catch (err) {
        const delay = RPC_BACKOFF_MS[attempt - 1];
        if (attempt >= maxAttempts || delay === undefined || !isRetryable(err)) throw err;
        await sleep(delay);
      }
    }
  }

  const read: RpcReads = {
    getParsedTransaction: (signature, f = finality) =>
      withRetry((c) =>
        c.getParsedTransaction(signature, { commitment: f, maxSupportedTransactionVersion: 0 }),
      ),
    getSignatureStatuses: (signatures, config) =>
      withRetry((c) => c.getSignatureStatuses(signatures, config)),
    getLatestBlockhash: () => withRetry((c) => c.getLatestBlockhash(commitment)),
    getBlockHeight: () => withRetry((c) => c.getBlockHeight(commitment)),
    getBalance: (address) => withRetry((c) => c.getBalance(address, commitment)),
    getAccountInfo: (address) => withRetry((c) => c.getAccountInfo(address, commitment)),
    getTokenAccountBalance: (address) =>
      withRetry((c) => c.getTokenAccountBalance(address, commitment)),
  };

  return { primary, fallback, commitment, withRetry, read };
}
