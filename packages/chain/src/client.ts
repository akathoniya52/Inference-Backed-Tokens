import {
  type Commitment,
  Connection,
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
  quoteSwap,
  readDammPool,
} from './damm.js';
import {
  buildCurveBuyTx,
  buildMigrateTx,
  type DbcPoolDto,
  type PoolRef,
  quoteBuy,
  readPool,
  verifyLaunch,
  type VerifyLaunchInput,
} from './dbc.js';
import { type DepositResult, parseDeposit } from './deposit.js';
import { createRpc, type Rpc } from './rpc.js';
import { NATIVE_MINT } from './sdk.js';
import { type AnyTransaction, sendAndConfirm } from './send.js';
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
}

export interface AddAndLockResult extends PositionKeys {
  addSignature: string;
  lockSignature: string;
  liquidityDelta: bigint;
  lamportsUsed: bigint;
  tokensUsed: bigint;
}

export type SignatureState = 'landed' | 'failed' | 'unknown';

export interface ChainClient {
  ping(): Promise<boolean>;
  getParsedTx(signature: string): Promise<ParsedTransactionWithMeta | null>;
  verifyDeposit(
    signature: string,
    expected: { treasuryAta: PublicKey; depositRef: string },
  ): Promise<DepositResult>;
  verifyLaunch(input: VerifyLaunchInput): Promise<{ pool: string }>;
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
  ): Promise<TxResult & { outAmount: bigint }>;
  migrate(keeper: Signer, pool: PublicKey, opts?: SendOpts): Promise<TxResult>;
  dammSwap(
    keeper: Signer,
    mint: PublicKey,
    swap: { inputMint: PublicKey; amountIn: bigint; slippageBps?: number },
    opts?: SendOpts,
  ): Promise<TxResult & { outAmount: bigint }>;
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
  ): Promise<TxResult & { outAmount: bigint }> {
    let outAmount = 0n;
    const { signature } = await this.send(
      'curveBuy',
      [keeper],
      {
        buildTx: async () => {
          const quote = await quoteBuy(this.connection, pool, lamports, opts.slippageBps ?? 100);
          outAmount = quote.outAmount;
          return buildCurveBuyTx(this.connection, keeper.publicKey, pool, lamports, quote.minOut);
        },
      },
      opts,
    );
    return { signature, outAmount };
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
  ): Promise<TxResult & { outAmount: bigint }> {
    const pool = await this.dammPool(mint);
    let outAmount = 0n;
    const { signature } = await this.send(
      'dammSwap',
      [keeper],
      {
        buildTx: async () => {
          const quote = await quoteSwap(this.connection, pool, {
            inputMint: swap.inputMint,
            amountIn: swap.amountIn,
            slippageBps: swap.slippageBps ?? 100,
          });
          outAmount = quote.outAmount;
          return buildSwap(this.connection, {
            payer: keeper.publicKey,
            pool,
            inputMint: swap.inputMint,
            amountIn: swap.amountIn,
            minOut: quote.minOut,
          });
        },
      },
      opts,
    );
    return { signature, outAmount };
  }

  async addAndLock(
    keeper: Signer,
    mint: PublicKey,
    input: AddAndLockInput,
    opts?: SendOpts,
  ): Promise<AddAndLockResult> {
    const pool = await this.dammPool(mint);
    const solIsA = pool.state.tokenAMint.equals(NATIVE_MINT);
    let quote = depositQuote(this.connection, pool, { inAmount: input.lamports, isTokenA: solIsA });
    let lamportsUsed = quote.inAmount;
    let tokensUsed = quote.outAmount;
    if (tokensUsed > input.maxTokens) {
      quote = depositQuote(this.connection, pool, { inAmount: input.maxTokens, isTokenA: !solIsA });
      tokensUsed = quote.inAmount;
      lamportsUsed = quote.outAmount;
    }
    const amounts = {
      liquidityDelta: quote.liquidityDelta,
      maxAmountTokenA: solIsA ? lamportsUsed : tokensUsed,
      maxAmountTokenB: solIsA ? tokensUsed : lamportsUsed,
    };

    let keys: PositionKeys;
    let addSignature: string;
    if (input.position) {
      keys = input.position;
      const tx = await buildAddLiquidity(this.connection, {
        owner: keeper.publicKey,
        pool,
        ...keys,
        ...amounts,
      });
      ({ signature: addSignature } = await this.send('addLiquidity', [keeper], { tx }, opts));
    } else {
      const created = await buildCreatePositionAndAdd(this.connection, {
        owner: keeper.publicKey,
        pool,
        ...amounts,
      });
      keys = { position: created.position, positionNftAccount: created.positionNftAccount };
      ({ signature: addSignature } = await this.send(
        'addLiquidity',
        [keeper],
        { tx: created.transaction },
        opts,
        created.extraSigners,
      ));
    }

    const lockTx = await buildPermanentLock(this.connection, {
      owner: keeper.publicKey,
      pool,
      ...keys,
      unlockedLiquidity: quote.liquidityDelta,
    });
    const { signature: lockSignature } = await this.send('lock', [keeper], { tx: lockTx }, opts);
    return {
      ...keys,
      addSignature,
      lockSignature,
      liquidityDelta: quote.liquidityDelta,
      lamportsUsed,
      tokensUsed,
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
    return status.err === null ? 'landed' : 'failed';
  }
}
