import { AppError } from '@ibt/shared';
import {
  type Commitment,
  Connection,
  Keypair,
  type ParsedTransactionWithMeta,
  type PublicKey,
  type Signer,
  Transaction,
} from '@solana/web3.js';

import {
  buildAddLiquidity,
  buildClaimPositionFee,
  buildCreatePositionAndAdd,
  buildPermanentLock,
  buildSwap,
  dammPoolDto,
  type DammPool,
  type DammPoolDto,
  deriveDammPool,
  depositQuote,
  maxBeforeSlippage,
  quoteSwap,
  quoteSwapDetailed,
  readDammPool,
  withSlippageUp,
} from './damm.js';
import {
  buildCurveBuyTx,
  buildMigrateTx,
  type DbcPoolDto,
  type PoolRef,
  quoteBuy,
  quoteCurveSwap,
  readCurveVaults,
  readPool,
  verifyLaunch,
  type VerifyLaunchInput,
} from './dbc.js';
import { type DepositResult, parseDeposit } from './deposit.js';
import { parseLiquidityFill, parseSwapFill, type SwapFill, type SwapFillAccounts } from './fill.js';
import { readTokenMetadata, type TokenMetadata } from './metadata.js';
import { createRpc, type Rpc } from './rpc.js';
import { derivePositionAddress, derivePositionNftAccount, NATIVE_MINT } from './sdk.js';
import {
  type AnyTransaction,
  type ExpiredSignatureState,
  expiredSignatureStatus,
  sendAndConfirm,
} from './send.js';
import { ataOf, usdcTransferIxs } from './spl.js';

/** Called after signing and before sending, with the step name for `settlements.pendingTx` (G20). */
export type ChainOnSigned = (
  signature: string,
  lastValidBlockHeight: number,
  step: string,
) => Promise<void> | void;

export interface SendOpts {
  onSigned?: ChainOnSigned;
  /** Free-form reference (e.g. settlement id) recorded with the tx by the fake chain. */
  settlementRef?: string;
}

export interface TxResult {
  signature: string;
}

export interface PositionKeys {
  position: PublicKey;
  positionNftAccount: PublicKey;
}

export interface AddAndLockInput {
  /** The keeper's existing position for this pool, or null to create one. */
  position: PositionKeys | null;
  lamports: bigint;
  /** Upper bound of model tokens the keeper may pair with `lamports`. */
  maxTokens: bigint;
  /**
   * Room above the quoted amounts the add may take if the price moves (default 100).
   * The quote is sized so the buffered maximums stay within `lamports` and `maxTokens`.
   */
  slippageBps?: number;
}

export interface AddAndLockResult extends PositionKeys {
  addSignature: string;
  lockSignature: string;
  liquidityDelta: bigint;
  /** Lamports and tokens the add tx actually moved into the pool vaults. */
  lamportsUsed: bigint;
  tokensUsed: bigint;
}

/** Actual amounts of a landed curve buy, from its token balance deltas. */
export interface CurveBuyResult extends TxResult {
  /** Model tokens the keeper received. */
  outAmount: bigint;
  /** Lamports the curve took (≤ the requested amount on a partial fill); the rest stays in the wallet. */
  lamportsSpent: bigint;
}

export interface DammSwapResult extends TxResult {
  /** Output base units actually received. */
  outAmount: bigint;
  /** Input base units actually taken. */
  amountIn: bigint;
}

/** Which swap a signature was, to read its actual amounts back (`swapFill`). */
export type SwapFillRef =
  | { venue: 'curve'; owner: PublicKey; pool: PublicKey }
  | { venue: 'damm'; owner: PublicKey; mint: PublicKey; inputMint: PublicKey };

/**
 * `landed`/`failed`: seen at `confirmed` or `finalized`. `pending`: only `processed`, which a
 * fork can still drop, so poll again. `unknown`: no status on this RPC.
 */
export type SignatureState = 'landed' | 'failed' | 'pending' | 'unknown';

export interface PoolQuoteInput {
  /** `buy` spends `amount` lamports; `sell` spends `amount` token base units. */
  side: 'buy' | 'sell';
  amount: bigint;
}

/** Read-only swap quote for display (L400); the browser builds the real transaction. */
export interface PoolQuote {
  amountIn: bigint;
  amountOut: bigint;
  fee: bigint;
  priceImpactPct: number | null;
}

export interface ChainClient {
  ping(): Promise<boolean>;
  getParsedTx(signature: string): Promise<ParsedTransactionWithMeta | null>;
  verifyDeposit(
    signature: string,
    expected: { treasuryAta: PublicKey; depositRef: string },
  ): Promise<DepositResult>;
  verifyLaunch(input: VerifyLaunchInput): Promise<{ pool: string }>;
  /** The mint's Metaplex metadata (name/symbol/uri NUL-trimmed), or null when it has none. */
  tokenMetadata(mint: PublicKey): Promise<TokenMetadata | null>;
  readPool(ref: PoolRef): Promise<DbcPoolDto | null>;
  readDammPool(mint: PublicKey): Promise<DammPoolDto | null>;
  tokenBalance(wallet: PublicKey, mint: PublicKey): Promise<bigint>;
  solBalance(wallet: PublicKey): Promise<bigint>;
  usdcBalance(wallet: PublicKey): Promise<bigint>;
  transferUsdc(
    from: Signer,
    toWallet: PublicKey,
    amount: bigint,
    opts?: SendOpts,
  ): Promise<TxResult>;
  curveBuy(
    keeper: Signer,
    pool: PublicKey,
    lamports: bigint,
    opts?: SendOpts & { slippageBps?: number },
  ): Promise<CurveBuyResult>;
  migrate(keeper: Signer, pool: PublicKey, opts?: SendOpts): Promise<TxResult>;
  dammSwap(
    keeper: Signer,
    mint: PublicKey,
    swap: { inputMint: PublicKey; amountIn: bigint; slippageBps?: number },
    opts?: SendOpts,
  ): Promise<DammSwapResult>;
  /** Actual amounts of a landed swap, e.g. one recovered from `pendingTx` without its result. */
  swapFill(signature: string, ref: SwapFillRef): Promise<SwapFill>;
  addAndLock(
    keeper: Signer,
    mint: PublicKey,
    input: AddAndLockInput,
    opts?: SendOpts,
  ): Promise<AddAndLockResult>;
  claimPositionFee(
    keeper: Signer,
    mint: PublicKey,
    position: PositionKeys,
    opts?: SendOpts,
  ): Promise<TxResult>;
  signatureStatus(signature: string): Promise<SignatureState>;
  /** Re-check for a tx past `lastValidBlockHeight`, against finalized state and full history. */
  expiredSignatureStatus(
    signature: string,
    lastValidBlockHeight: number,
  ): Promise<ExpiredSignatureState>;
  quoteCurve(pool: PublicKey, input: PoolQuoteInput): Promise<PoolQuote>;
  quoteDamm(mint: PublicKey, input: PoolQuoteInput): Promise<PoolQuote>;
}

export interface RealChainClientOptions {
  rpcUrl: string;
  fallbackUrl?: string;
  commitment?: Commitment;
  usdcMint: PublicKey;
}

export class RealChainClient implements ChainClient {
  readonly rpc: Rpc<Connection>;
  private readonly commitment: Commitment;
  private readonly usdcMint: PublicKey;

  constructor(opts: RealChainClientOptions) {
    this.rpc = createRpc({
      rpcUrl: opts.rpcUrl,
      ...(opts.fallbackUrl ? { fallbackUrl: opts.fallbackUrl } : {}),
      commitment: opts.commitment ?? 'confirmed',
    });
    this.commitment = this.rpc.commitment;
    this.usdcMint = opts.usdcMint;
  }

  private get connection(): Connection {
    return this.rpc.primary;
  }

  private send(
    step: string,
    signers: Signer[],
    tx: { tx: AnyTransaction } | { buildTx: () => Promise<AnyTransaction> },
    opts: SendOpts = {},
    extraSigners: Signer[] = [],
  ): Promise<TxResult> {
    const { onSigned } = opts;
    return sendAndConfirm({
      ...tx,
      connection: this.connection,
      signers,
      extraSigners,
      commitment: this.commitment,
      ...(onSigned ? { onSigned: (sig: string, lvbh: number) => onSigned(sig, lvbh, step) } : {}),
    });
  }

  private async dammPool(mint: PublicKey): Promise<DammPool> {
    const address = deriveDammPool(mint);
    const pool = await readDammPool(this.connection, address);
    if (!pool) throw new Error(`DAMM v2 pool ${address.toBase58()} not found`);
    return pool;
  }

  async ping(): Promise<boolean> {
    await this.rpc.read.getBlockHeight();
    return true;
  }

  getParsedTx(signature: string): Promise<ParsedTransactionWithMeta | null> {
    return this.rpc.read.getParsedTransaction(signature, 'finalized');
  }

  async verifyDeposit(
    signature: string,
    expected: { treasuryAta: PublicKey; depositRef: string },
  ): Promise<DepositResult> {
    const tx = await this.getParsedTx(signature);
    return parseDeposit(tx, {
      ...expected,
      usdcMint: this.usdcMint,
      confirmationStatus: tx ? 'finalized' : null,
    });
  }

  verifyLaunch(input: VerifyLaunchInput): Promise<{ pool: string }> {
    return verifyLaunch(this.connection, input);
  }

  tokenMetadata(mint: PublicKey): Promise<TokenMetadata | null> {
    return readTokenMetadata(this.rpc.read, mint);
  }

  /** A landed tx at `confirmed`, retried (bounded) while the RPC does not serve it yet. */
  private async landedTx(signature: string): Promise<ParsedTransactionWithMeta> {
    try {
      return await this.rpc.withRetry(async (conn) => {
        const tx = await conn.getParsedTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        if (!tx) throw new Error('transaction not visible at confirmed yet');
        return tx;
      });
    } catch (err) {
      throw new AppError('chain_send_failed', {
        message: 'transaction landed but could not be read back',
        details: { signature, landed: true },
        cause: err,
      });
    }
  }

  private async fill(signature: string, accounts: SwapFillAccounts): Promise<SwapFill> {
    const fill = parseSwapFill(await this.landedTx(signature), accounts);
    if (!fill) {
      throw new AppError('chain_send_failed', {
        message: 'landed swap moved no tokens',
        details: { signature, landed: true },
      });
    }
    return fill;
  }

  private async swapAccounts(ref: SwapFillRef): Promise<SwapFillAccounts> {
    if (ref.venue === 'curve') {
      const vaults = await readCurveVaults(this.connection, ref.pool);
      return {
        owner: ref.owner,
        inputVault: vaults.quoteVault,
        outputVault: vaults.baseVault,
        outputMint: vaults.baseMint,
      };
    }
    const { state } = await this.dammPool(ref.mint);
    const aIn = ref.inputMint.equals(state.tokenAMint);
    return {
      owner: ref.owner,
      inputVault: aIn ? state.tokenAVault : state.tokenBVault,
      outputVault: aIn ? state.tokenBVault : state.tokenAVault,
      outputMint: aIn ? state.tokenBMint : state.tokenAMint,
    };
  }

  async swapFill(signature: string, ref: SwapFillRef): Promise<SwapFill> {
    return this.fill(signature, await this.swapAccounts(ref));
  }

  readPool(ref: PoolRef): Promise<DbcPoolDto | null> {
    return readPool(this.connection, ref);
  }

  async readDammPool(mint: PublicKey): Promise<DammPoolDto | null> {
    const pool = await readDammPool(this.connection, deriveDammPool(mint));
    return pool && dammPoolDto(pool);
  }

  async tokenBalance(wallet: PublicKey, mint: PublicKey): Promise<bigint> {
    const ata = ataOf(wallet, mint);
    if (!(await this.rpc.read.getAccountInfo(ata))) return 0n;
    const { value } = await this.rpc.read.getTokenAccountBalance(ata);
    return BigInt(value.amount);
  }

  async solBalance(wallet: PublicKey): Promise<bigint> {
    return BigInt(await this.rpc.read.getBalance(wallet));
  }

  usdcBalance(wallet: PublicKey): Promise<bigint> {
    return this.tokenBalance(wallet, this.usdcMint);
  }

  async quoteCurve(pool: PublicKey, { side, amount }: PoolQuoteInput): Promise<PoolQuote> {
    const quote = await quoteCurveSwap(this.connection, pool, { side, amountIn: amount });
    return {
      amountIn: quote.amountIn,
      amountOut: quote.outAmount,
      fee: quote.fee,
      priceImpactPct: null,
    };
  }

  async quoteDamm(mint: PublicKey, { side, amount }: PoolQuoteInput): Promise<PoolQuote> {
    const quote = await quoteSwapDetailed(this.connection, await this.dammPool(mint), {
      inputMint: side === 'buy' ? NATIVE_MINT : mint,
      amountIn: amount,
    });
    return {
      amountIn: quote.amountIn,
      amountOut: quote.outAmount,
      fee: quote.fee,
      priceImpactPct: quote.priceImpactPct,
    };
  }

  transferUsdc(
    from: Signer,
    toWallet: PublicKey,
    amount: bigint,
    opts?: SendOpts,
  ): Promise<TxResult> {
    const ixs = usdcTransferIxs({
      usdcMint: this.usdcMint,
      from: from.publicKey,
      toWallet,
      amount,
    });
    return this.send('payout', [from], { tx: new Transaction().add(...ixs) }, opts);
  }

  async curveBuy(
    keeper: Signer,
    pool: PublicKey,
    lamports: bigint,
    opts: SendOpts & { slippageBps?: number } = {},
  ): Promise<CurveBuyResult> {
    const accounts = await this.swapAccounts({ venue: 'curve', owner: keeper.publicKey, pool });
    const { signature } = await this.send(
      'curveBuy',
      [keeper],
      {
        buildTx: async () => {
          const quote = await quoteBuy(this.connection, pool, lamports, opts.slippageBps ?? 100);
          return buildCurveBuyTx(this.connection, keeper.publicKey, pool, lamports, quote.minOut);
        },
      },
      opts,
    );
    const fill = await this.fill(signature, accounts);
    return { signature, outAmount: fill.amountOut, lamportsSpent: fill.amountIn };
  }

  async migrate(keeper: Signer, pool: PublicKey, opts?: SendOpts): Promise<TxResult> {
    const { transaction, extraSigners } = await buildMigrateTx(
      this.connection,
      keeper.publicKey,
      pool,
    );
    return this.send('migrate', [keeper], { tx: transaction }, opts, extraSigners);
  }

  async dammSwap(
    keeper: Signer,
    mint: PublicKey,
    swap: { inputMint: PublicKey; amountIn: bigint; slippageBps?: number },
    opts?: SendOpts,
  ): Promise<DammSwapResult> {
    const pool = await this.dammPool(mint);
    const accounts = await this.swapAccounts({
      venue: 'damm',
      owner: keeper.publicKey,
      mint,
      inputMint: swap.inputMint,
    });
    const { signature } = await this.send(
      'dammSwap',
      [keeper],
      {
        buildTx: async () => {
          const fresh = await readDammPool(this.connection, pool.address);
          const current = fresh ?? pool;
          const quote = await quoteSwap(this.connection, current, {
            inputMint: swap.inputMint,
            amountIn: swap.amountIn,
            slippageBps: swap.slippageBps ?? 100,
          });
          return buildSwap(this.connection, {
            payer: keeper.publicKey,
            pool: current,
            inputMint: swap.inputMint,
            amountIn: swap.amountIn,
            minOut: quote.minOut,
          });
        },
      },
      opts,
    );
    const fill = await this.fill(signature, accounts);
    return { signature, outAmount: fill.amountOut, amountIn: fill.amountIn };
  }

  /**
   * Sizes a deposit so `withSlippageUp` of both sides stays within `lamports`/`maxTokens`;
   * the buffered amounts are the on-chain maximums (`tokenX AmountThreshold`).
   */
  private addQuote(pool: DammPool, input: AddAndLockInput) {
    const bps = input.slippageBps ?? 100;
    const solIsA = pool.state.tokenAMint.equals(NATIVE_MINT);
    let quote = depositQuote(this.connection, pool, {
      inAmount: maxBeforeSlippage(input.lamports, bps),
      isTokenA: solIsA,
    });
    let lamports = quote.inAmount;
    let tokens = quote.outAmount;
    if (withSlippageUp(tokens, bps) > input.maxTokens) {
      quote = depositQuote(this.connection, pool, {
        inAmount: maxBeforeSlippage(input.maxTokens, bps),
        isTokenA: !solIsA,
      });
      tokens = quote.inAmount;
      lamports = quote.outAmount;
    }
    const maxLamports = withSlippageUp(lamports, bps);
    const maxTokens = withSlippageUp(tokens, bps);
    return {
      liquidityDelta: quote.liquidityDelta,
      maxAmountTokenA: solIsA ? maxLamports : maxTokens,
      maxAmountTokenB: solIsA ? maxTokens : maxLamports,
    };
  }

  async addAndLock(
    keeper: Signer,
    mint: PublicKey,
    input: AddAndLockInput,
    opts?: SendOpts,
  ): Promise<AddAndLockResult> {
    const initial = await this.dammPool(mint);
    const solIsA = initial.state.tokenAMint.equals(NATIVE_MINT);
    // Fixed across rebuilds: a rebuilt create cannot open a second position.
    const nft = Keypair.generate();
    const positionNft = input.position ? null : nft;
    let liquidityDelta = 0n;
    const buildTx = async () => {
      const pool = (await readDammPool(this.connection, initial.address)) ?? initial;
      const amounts = this.addQuote(pool, input);
      liquidityDelta = amounts.liquidityDelta;
      if (input.position) {
        return buildAddLiquidity(this.connection, {
          owner: keeper.publicKey,
          pool,
          ...input.position,
          ...amounts,
        });
      }
      const created = await buildCreatePositionAndAdd(this.connection, {
        owner: keeper.publicKey,
        pool,
        ...(positionNft ? { positionNft } : {}),
        ...amounts,
      });
      return created.transaction;
    };

    const keys: PositionKeys = input.position ?? {
      position: derivePositionAddress(nft.publicKey),
      positionNftAccount: derivePositionNftAccount(nft.publicKey),
    };
    const { signature: addSignature } = await this.send(
      'addLiquidity',
      [keeper],
      { buildTx },
      opts,
      positionNft ? [positionNft] : [],
    );
    const added = parseLiquidityFill(await this.landedTx(addSignature), initial.state);
    if (!added) {
      throw new AppError('chain_send_failed', {
        message: 'landed add-liquidity could not be read back',
        details: { signature: addSignature, landed: true },
      });
    }

    const lockTx = await buildPermanentLock(this.connection, {
      owner: keeper.publicKey,
      pool: initial,
      ...keys,
      unlockedLiquidity: liquidityDelta,
    });
    const { signature: lockSignature } = await this.send('lock', [keeper], { tx: lockTx }, opts);
    return {
      ...keys,
      addSignature,
      lockSignature,
      liquidityDelta,
      lamportsUsed: solIsA ? added.amountA : added.amountB,
      tokensUsed: solIsA ? added.amountB : added.amountA,
    };
  }

  async claimPositionFee(
    keeper: Signer,
    mint: PublicKey,
    position: PositionKeys,
    opts?: SendOpts,
  ): Promise<TxResult> {
    const pool = await this.dammPool(mint);
    const tx = await buildClaimPositionFee(this.connection, {
      owner: keeper.publicKey,
      pool,
      ...position,
    });
    return this.send('claimPositionFee', [keeper], { tx }, opts);
  }

  async signatureStatus(signature: string): Promise<SignatureState> {
    const { value } = await this.rpc.read.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = value[0];
    if (!status) return 'unknown';
    const { confirmationStatus } = status;
    if (confirmationStatus !== 'confirmed' && confirmationStatus !== 'finalized') return 'pending';
    return status.err === null ? 'landed' : 'failed';
  }

  /** All reads go to the primary so the ledger range and the status come from the same node. */
  expiredSignatureStatus(
    signature: string,
    lastValidBlockHeight: number,
  ): Promise<ExpiredSignatureState> {
    return expiredSignatureStatus(this.rpc.primary, signature, lastValidBlockHeight);
  }
}
