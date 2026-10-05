import { randomBytes } from 'node:crypto';

import { AppError } from '@ibt/shared';
import { type ParsedTransactionWithMeta, PublicKey, type Signer } from '@solana/web3.js';
import bs58 from 'bs58';

import type {
  AddAndLockInput,
  AddAndLockResult,
  ChainClient,
  ExpiredSignatureState,
  PoolQuote,
  PoolQuoteInput,
  PositionKeys,
  SendOpts,
  SignatureState,
  TxResult,
} from '../client.js';
import { deriveDammPool, type DammPoolDto } from '../damm.js';
import { curveProgress, dbcPoolAddress, type DbcPoolDto, type PoolRef } from '../dbc.js';
import { type DepositResult, parseDeposit } from '../deposit.js';
import { FakePriceSource, type PriceSource } from '../price.js';
import { NATIVE_MINT, USDC_MINT } from '../sdk.js';
import type { VerifyLaunchInput } from '../dbc.js';

export interface FakeChainTx {
  signature: string;
  method: string;
  from: string;
  to: string;
  amount: string;
  mint: string;
  settlementRef: string | null;
  ts: Date;
}

/** A DBC pool persisted in `fakeChainPools` so other processes (keeper, api) can read it. */
export interface FakeChainPoolRow {
  mint: string;
  address: string;
  config: string;
  creator: string;
  quoteReserve: string;
  baseReserve: string;
  isMigrated: boolean;
  dammLiquidity: string | null;
}

/** The fake SOL price persisted in `fakeChainPrices`, keyed by the WSOL mint. */
export interface FakeChainPriceRow {
  mint: string;
  usd: number;
}

/** Structural slice of a Mongo/mongoose connection; `@ibt/chain` never imports mongoose (G11). */
export interface FakeChainMongo {
  collection(name: string): {
    insertOne(doc: FakeChainTx): Promise<unknown>;
    findOne(filter: Partial<FakeChainTx>): Promise<unknown>;
    find(filter: Partial<FakeChainTx>): { toArray(): Promise<unknown[]> };
    /** Needed only to persist pools and prices (`addPersistedPool`, `saveFakeSolUsd`). */
    replaceOne?(
      filter: Partial<FakeChainTx>,
      doc: FakeChainTx | FakeChainPoolRow | FakeChainPriceRow,
      options: { upsert: boolean },
    ): Promise<unknown>;
  };
}

export interface FakeChainOptions {
  mongo?: FakeChainMongo;
  priceSource?: PriceSource;
  usdcMint?: PublicKey;
}

export type FakeChainMethod = keyof ChainClient;

export interface FakeChainCall {
  method: FakeChainMethod;
  args: unknown[];
}

interface FakePool {
  address: PublicKey;
  mint: PublicKey;
  config: PublicKey;
  creator: PublicKey;
  quoteReserve: bigint;
  baseReserve: bigint;
  isMigrated: boolean;
  dammLiquidity: bigint | null;
  /** Loaded from or saved to `fakeChainPools`; state changes are written back. */
  persisted?: boolean;
}

const COLLECTION = 'fakeChainTxs';
export const FAKE_POOLS_COLLECTION = 'fakeChainPools';
export const FAKE_PRICES_COLLECTION = 'fakeChainPrices';
const SOL = 'SOL';
/** Fixed fake exchange rate: model token base units per lamport. */
export const FAKE_TOKENS_PER_LAMPORT = 1000n;
const INITIAL_BASE_RESERVE = 800_000_000_000_000n;

const isTxRow = (row: unknown): row is FakeChainTx =>
  typeof row === 'object' &&
  row !== null &&
  'signature' in row &&
  typeof row.signature === 'string';

const isPoolRow = (row: unknown): row is FakeChainPoolRow =>
  typeof row === 'object' &&
  row !== null &&
  'mint' in row &&
  typeof row.mint === 'string' &&
  'address' in row &&
  typeof row.address === 'string' &&
  'config' in row &&
  typeof row.config === 'string' &&
  'creator' in row &&
  typeof row.creator === 'string' &&
  'quoteReserve' in row &&
  typeof row.quoteReserve === 'string' &&
  'baseReserve' in row &&
  typeof row.baseReserve === 'string' &&
  'isMigrated' in row &&
  typeof row.isMigrated === 'boolean' &&
  'dammLiquidity' in row &&
  (row.dammLiquidity === null || typeof row.dammLiquidity === 'string');

async function upsertByMint(
  mongo: FakeChainMongo,
  name: string,
  doc: FakeChainPoolRow | FakeChainPriceRow,
): Promise<void> {
  const collection = mongo.collection(name);
  if (!collection.replaceOne) {
    throw new Error(`fake chain: the ${name} collection has no replaceOne`);
  }
  await collection.replaceOne({ mint: doc.mint }, doc, { upsert: true });
}

/** Stores the SOL price a `CHAIN_MODE=fake` process should use (see `loadFakeSolUsd`). */
export async function saveFakeSolUsd(mongo: FakeChainMongo, usd: number): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) throw new RangeError('usd must be a positive number');
  await upsertByMint(mongo, FAKE_PRICES_COLLECTION, { mint: NATIVE_MINT.toBase58(), usd });
}

/** The SOL price saved by `saveFakeSolUsd`, or null when none was seeded. */
export async function loadFakeSolUsd(mongo: FakeChainMongo): Promise<number | null> {
  const row = await mongo
    .collection(FAKE_PRICES_COLLECTION)
    .findOne({ mint: NATIVE_MINT.toBase58() });
  if (typeof row !== 'object' || row === null || !('usd' in row)) return null;
  return typeof row.usd === 'number' && Number.isFinite(row.usd) && row.usd > 0 ? row.usd : null;
}

export class FakeChain implements ChainClient {
  readonly calls: FakeChainCall[] = [];
  readonly txs: FakeChainTx[] = [];
  readonly priceSource: PriceSource;
  readonly usdcMint: PublicKey;
  private readonly mongo: FakeChainMongo | undefined;
  private readonly pools = new Map<string, FakePool>();
  private readonly balances = new Map<string, bigint>();
  private readonly parsedTxs = new Map<string, ParsedTransactionWithMeta>();
  private readonly failures = new Map<string, number>();
  private readonly crashBeforeLand = new Set<string>();
  private readonly crashAfterLanding = new Set<string>();
  private threshold = 10_000_000_000n;
  private blockHeight = 1000;
  private historyAvailable = true;
  private hydrated: Promise<void> | null = null;

  constructor(opts: FakeChainOptions = {}) {
    this.mongo = opts.mongo;
    this.priceSource = opts.priceSource ?? new FakePriceSource(150);
    this.usdcMint = opts.usdcMint ?? USDC_MINT.devnet;
  }

  addPool({ mint, config, creator }: { mint: PublicKey; config: PublicKey; creator: PublicKey }) {
    const address = dbcPoolAddress({ mint, config });
    this.pools.set(mint.toBase58(), {
      address,
      mint,
      config,
      creator,
      quoteReserve: 0n,
      baseReserve: INITIAL_BASE_RESERVE,
      isMigrated: false,
      dammLiquidity: null,
    });
    return address;
  }

  /** `addPool`, also saved to `fakeChainPools` so a fresh instance on the same Mongo sees it. */
  async addPersistedPool(input: {
    mint: PublicKey;
    config: PublicKey;
    creator: PublicKey;
  }): Promise<PublicKey> {
    await this.hydrate();
    const existing = this.pools.get(input.mint.toBase58());
    if (existing?.persisted && existing.config.equals(input.config)) return existing.address;
    const address = this.addPool(input);
    const pool = this.requirePool({ pool: address });
    pool.persisted = true;
    await this.savePool(pool);
    return address;
  }

  setBalance(wallet: PublicKey, mint: PublicKey | typeof SOL, amount: bigint): void {
    this.balances.set(this.key(wallet, mint), amount);
  }

  setSol(wallet: PublicKey, lamports: bigint): void {
    this.setBalance(wallet, SOL, lamports);
  }

  setUsdc(wallet: PublicKey, micro: bigint): void {
    this.setBalance(wallet, this.usdcMint, micro);
  }

  setParsedTx(signature: string, tx: ParsedTransactionWithMeta): void {
    this.parsedTxs.set(signature, tx);
  }

  /** The next `n` calls of `method` throw `chain_send_failed` before signing. */
  failNext(method: FakeChainMethod, n = 1): void {
    this.failures.set(method, (this.failures.get(method) ?? 0) + n);
  }

  /** The next send of `method` is signed (`onSigned` runs) but crashes before landing. */
  crashAfter(method: FakeChainMethod): void {
    this.crashBeforeLand.add(method);
  }

  /** The next send of `method` lands, then the call throws before returning. */
  crashAfterLand(method: FakeChainMethod): void {
    this.crashAfterLanding.add(method);
  }

  /** Curve completes once `quoteReserve` reaches `lamports`; `migrate` then graduates it. */
  migrateWhen(lamports: bigint): void {
    this.threshold = lamports;
  }

  async landedTxs(filter: Partial<FakeChainTx> = {}): Promise<FakeChainTx[]> {
    if (!this.mongo) {
      return this.txs.filter((tx) =>
        Object.entries(filter).every(([k, v]) => tx[k as keyof FakeChainTx] === v),
      );
    }
    const rows = await this.mongo.collection(COLLECTION).find(filter).toArray();
    return rows.filter(isTxRow);
  }

  ping(): Promise<boolean> {
    this.record('ping', []);
    return Promise.resolve(true);
  }

  getParsedTx(signature: string): Promise<ParsedTransactionWithMeta | null> {
    this.record('getParsedTx', [signature]);
    return Promise.resolve(this.parsedTxs.get(signature) ?? null);
  }

  verifyDeposit(
    signature: string,
    expected: { treasuryAta: PublicKey; depositRef: string },
  ): Promise<DepositResult> {
    this.record('verifyDeposit', [signature, expected]);
    const tx = this.parsedTxs.get(signature) ?? null;
    return Promise.resolve(
      parseDeposit(tx, {
        ...expected,
        usdcMint: this.usdcMint,
        confirmationStatus: tx ? 'finalized' : null,
      }),
    );
  }

  async verifyLaunch(input: VerifyLaunchInput): Promise<{ pool: string }> {
    this.record('verifyLaunch', [input]);
    await this.hydrate();
    const pool = this.pools.get(input.mint.toBase58());
    const reason = !pool
      ? 'pool_not_found'
      : !pool.config.equals(input.expectedConfig)
        ? 'config'
        : !pool.creator.equals(input.expectedCreator)
          ? 'creator'
          : null;
    if (reason || !pool) {
      throw new AppError('pool_mismatch', { details: { reason: reason ?? 'pool_not_found' } });
    }
    return { pool: pool.address.toBase58() };
  }

  async readPool(ref: PoolRef): Promise<DbcPoolDto | null> {
    this.record('readPool', [ref]);
    await this.hydrate();
    const pool = this.poolByRef(ref);
    return pool && this.dto(pool);
  }

  async readDammPool(mint: PublicKey): Promise<DammPoolDto | null> {
    this.record('readDammPool', [mint]);
    await this.hydrate();
    const pool = this.pools.get(mint.toBase58());
    if (!pool || pool.dammLiquidity === null) return null;
    return {
      address: deriveDammPool(mint).toBase58(),
      tokenAMint: mint.toBase58(),
      tokenBMint: NATIVE_MINT.toBase58(),
      liquidity: pool.dammLiquidity.toString(),
      sqrtPrice: '18446744073709551616',
    };
  }

  tokenBalance(wallet: PublicKey, mint: PublicKey): Promise<bigint> {
    this.record('tokenBalance', [wallet, mint]);
    return Promise.resolve(this.balanceOf(wallet, mint));
  }

  solBalance(wallet: PublicKey): Promise<bigint> {
    this.record('solBalance', [wallet]);
    return Promise.resolve(this.balanceOf(wallet, SOL));
  }

  usdcBalance(wallet: PublicKey): Promise<bigint> {
    this.record('usdcBalance', [wallet]);
    return Promise.resolve(this.balanceOf(wallet, this.usdcMint));
  }

  /** Fixed-rate mirror of `curveBuy` (buys stop at the curve's remaining room); no fee. */
  quoteCurve(poolAddress: PublicKey, input: PoolQuoteInput): Promise<PoolQuote> {
    this.record('quoteCurve', [poolAddress, input]);
    const pool = this.poolByRef({ pool: poolAddress });
    if (!pool || pool.isMigrated) {
      return Promise.reject(new Error('fake chain: curve pool not found'));
    }
    const room = this.threshold - pool.quoteReserve;
    const amountIn = input.side === 'buy' && input.amount > room ? room : input.amount;
    return Promise.resolve(this.fixedRateQuote(input.side, amountIn < 0n ? 0n : amountIn));
  }

  /** Fixed-rate mirror of `dammSwap`; no fee, no price impact. */
  quoteDamm(mint: PublicKey, input: PoolQuoteInput): Promise<PoolQuote> {
    this.record('quoteDamm', [mint, input]);
    const pool = this.pools.get(mint.toBase58());
    if (!pool || pool.dammLiquidity === null) {
      return Promise.reject(new Error('fake chain: DAMM pool not found'));
    }
    return Promise.resolve({ ...this.fixedRateQuote(input.side, input.amount), priceImpactPct: 0 });
  }

  transferUsdc(
    from: Signer,
    toWallet: PublicKey,
    amount: bigint,
    opts?: SendOpts,
  ): Promise<TxResult> {
    this.record('transferUsdc', [from.publicKey, toWallet, amount, opts]);
    return this.send('transferUsdc', 'payout', opts, {
      from: from.publicKey,
      to: toWallet,
      amount,
      mint: this.usdcMint,
      apply: () => {
        this.move(from.publicKey, this.usdcMint, -amount);
        this.move(toWallet, this.usdcMint, amount);
      },
    });
  }

  async curveBuy(
    keeper: Signer,
    poolAddress: PublicKey,
    lamports: bigint,
    opts?: SendOpts & { slippageBps?: number },
  ): Promise<TxResult & { outAmount: bigint }> {
    this.record('curveBuy', [keeper.publicKey, poolAddress, lamports, opts]);
    await this.hydrate();
    const pool = this.requirePool({ pool: poolAddress });
    const room = this.threshold - pool.quoteReserve;
    if (pool.isMigrated || room <= 0n) throw new Error('fake chain: curve is complete');
    const spent = lamports < room ? lamports : room;
    const outAmount = spent * FAKE_TOKENS_PER_LAMPORT;
    const { signature } = await this.send('curveBuy', 'curveBuy', opts, {
      from: keeper.publicKey,
      to: poolAddress,
      amount: spent,
      mint: NATIVE_MINT,
      pool,
      apply: () => {
        pool.quoteReserve += spent;
        pool.baseReserve -= outAmount;
        this.move(keeper.publicKey, SOL, -spent);
        this.move(keeper.publicKey, pool.mint, outAmount);
      },
    });
    return { signature, outAmount };
  }

  async migrate(keeper: Signer, poolAddress: PublicKey, opts?: SendOpts): Promise<TxResult> {
    this.record('migrate', [keeper.publicKey, poolAddress, opts]);
    await this.hydrate();
    const pool = this.requirePool({ pool: poolAddress });
    if (pool.quoteReserve < this.threshold) throw new Error('fake chain: curve is not complete');
    return this.send('migrate', 'migrate', opts, {
      from: keeper.publicKey,
      to: poolAddress,
      amount: 0n,
      mint: pool.mint,
      pool,
      apply: () => {
        pool.isMigrated = true;
        pool.dammLiquidity = pool.quoteReserve;
      },
    });
  }

  async dammSwap(
    keeper: Signer,
    mint: PublicKey,
    swap: { inputMint: PublicKey; amountIn: bigint; slippageBps?: number },
    opts?: SendOpts,
  ): Promise<TxResult & { outAmount: bigint }> {
    this.record('dammSwap', [keeper.publicKey, mint, swap, opts]);
    await this.hydrate();
    this.requireDamm(mint);
    const solIn = swap.inputMint.equals(NATIVE_MINT);
    const outAmount = solIn
      ? swap.amountIn * FAKE_TOKENS_PER_LAMPORT
      : swap.amountIn / FAKE_TOKENS_PER_LAMPORT;
    const { signature } = await this.send('dammSwap', 'dammSwap', opts, {
      from: keeper.publicKey,
      to: deriveDammPool(mint),
      amount: swap.amountIn,
      mint: swap.inputMint,
      apply: () => {
        this.move(keeper.publicKey, solIn ? SOL : mint, -swap.amountIn);
        this.move(keeper.publicKey, solIn ? mint : SOL, outAmount);
      },
    });
    return { signature, outAmount };
  }

  async addAndLock(
    keeper: Signer,
    mint: PublicKey,
    input: AddAndLockInput,
    opts?: SendOpts,
  ): Promise<AddAndLockResult> {
    this.record('addAndLock', [keeper.publicKey, mint, input, opts]);
    await this.hydrate();
    const pool = this.requireDamm(mint);
    let lamportsUsed = input.lamports;
    let tokensUsed = lamportsUsed * FAKE_TOKENS_PER_LAMPORT;
    if (tokensUsed > input.maxTokens) {
      tokensUsed = input.maxTokens;
      lamportsUsed = tokensUsed / FAKE_TOKENS_PER_LAMPORT;
    }
    const keys: PositionKeys = input.position ?? {
      position: PublicKey.unique(),
      positionNftAccount: PublicKey.unique(),
    };
    const pool58 = deriveDammPool(mint);
    const { signature: addSignature } = await this.send('addAndLock', 'addLiquidity', opts, {
      from: keeper.publicKey,
      to: pool58,
      amount: lamportsUsed,
      mint: NATIVE_MINT,
      pool,
      apply: () => {
        this.move(keeper.publicKey, SOL, -lamportsUsed);
        this.move(keeper.publicKey, mint, -tokensUsed);
        pool.dammLiquidity = (pool.dammLiquidity ?? 0n) + lamportsUsed;
      },
    });
    const { signature: lockSignature } = await this.send('addAndLock', 'lock', opts, {
      from: keeper.publicKey,
      to: keys.position,
      amount: lamportsUsed,
      mint,
      apply: () => undefined,
    });
    return {
      ...keys,
      addSignature,
      lockSignature,
      liquidityDelta: lamportsUsed,
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
    this.record('claimPositionFee', [keeper.publicKey, mint, position, opts]);
    await this.hydrate();
    this.requireDamm(mint);
    return this.send('claimPositionFee', 'claimPositionFee', opts, {
      from: position.position,
      to: keeper.publicKey,
      amount: 0n,
      mint: NATIVE_MINT,
      apply: () => undefined,
    });
  }

  async signatureStatus(signature: string): Promise<SignatureState> {
    this.record('signatureStatus', [signature]);
    if (!this.historyAvailable) return 'unknown';
    return (await this.hasLanded(signature)) ? 'landed' : 'unknown';
  }

  /** The fake chain keeps every landed tx, so a signature it never landed is `absent`. */
  async expiredSignatureStatus(
    signature: string,
    lastValidBlockHeight: number,
  ): Promise<ExpiredSignatureState> {
    this.record('expiredSignatureStatus', [signature, lastValidBlockHeight]);
    if (!this.historyAvailable) return 'unknown';
    return (await this.hasLanded(signature)) ? 'landed' : 'absent';
  }

  /** `false` answers every status query `unknown`, like an RPC that pruned its history. */
  setHistoryAvailable(available: boolean): void {
    this.historyAvailable = available;
  }

  private async hasLanded(signature: string): Promise<boolean> {
    if (this.txs.some((tx) => tx.signature === signature)) return true;
    if (!this.mongo) return false;
    return isTxRow(await this.mongo.collection(COLLECTION).findOne({ signature }));
  }

  /** Loads `fakeChainPools` once; pools already in memory win. */
  private hydrate(): Promise<void> {
    this.hydrated ??= this.loadPools();
    return this.hydrated;
  }

  private async loadPools(): Promise<void> {
    if (!this.mongo) return;
    const rows = await this.mongo.collection(FAKE_POOLS_COLLECTION).find({}).toArray();
    for (const row of rows.filter(isPoolRow)) {
      if (this.pools.has(row.mint)) continue;
      this.pools.set(row.mint, {
        address: new PublicKey(row.address),
        mint: new PublicKey(row.mint),
        config: new PublicKey(row.config),
        creator: new PublicKey(row.creator),
        quoteReserve: BigInt(row.quoteReserve),
        baseReserve: BigInt(row.baseReserve),
        isMigrated: row.isMigrated,
        dammLiquidity: row.dammLiquidity === null ? null : BigInt(row.dammLiquidity),
        persisted: true,
      });
    }
  }

  private async savePool(pool: FakePool): Promise<void> {
    if (!this.mongo) throw new Error('fake chain: persisting a pool needs the mongo option');
    await upsertByMint(this.mongo, FAKE_POOLS_COLLECTION, {
      mint: pool.mint.toBase58(),
      address: pool.address.toBase58(),
      config: pool.config.toBase58(),
      creator: pool.creator.toBase58(),
      quoteReserve: pool.quoteReserve.toString(),
      baseReserve: pool.baseReserve.toString(),
      isMigrated: pool.isMigrated,
      dammLiquidity: pool.dammLiquidity === null ? null : pool.dammLiquidity.toString(),
    });
  }

  private record(method: FakeChainMethod, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  private fixedRateQuote(side: PoolQuoteInput['side'], amountIn: bigint): PoolQuote {
    const amountOut =
      side === 'buy' ? amountIn * FAKE_TOKENS_PER_LAMPORT : amountIn / FAKE_TOKENS_PER_LAMPORT;
    return { amountIn, amountOut, fee: 0n, priceImpactPct: null };
  }

  private key(wallet: PublicKey, mint: PublicKey | typeof SOL): string {
    return `${wallet.toBase58()}:${mint === SOL ? SOL : mint.toBase58()}`;
  }

  private balanceOf(wallet: PublicKey, mint: PublicKey | typeof SOL): bigint {
    return this.balances.get(this.key(wallet, mint)) ?? 0n;
  }

  private move(wallet: PublicKey, mint: PublicKey | typeof SOL, delta: bigint): void {
    const next = this.balanceOf(wallet, mint) + delta;
    if (next < 0n)
      throw new Error(`fake chain: insufficient balance for ${this.key(wallet, mint)}`);
    this.balances.set(this.key(wallet, mint), next);
  }

  private poolByRef(ref: PoolRef): FakePool | null {
    if ('mint' in ref) {
      const pool = this.pools.get(ref.mint.toBase58());
      return pool && pool.config.equals(ref.config) ? pool : null;
    }
    return [...this.pools.values()].find((p) => p.address.equals(ref.pool)) ?? null;
  }

  private requirePool(ref: PoolRef): FakePool {
    const pool = this.poolByRef(ref);
    if (!pool) throw new Error('fake chain: pool not found');
    return pool;
  }

  private requireDamm(mint: PublicKey): FakePool {
    const pool = this.pools.get(mint.toBase58());
    if (!pool || pool.dammLiquidity === null) throw new Error('fake chain: DAMM pool not found');
    return pool;
  }

  private dto(pool: FakePool): DbcPoolDto {
    return {
      address: pool.address.toBase58(),
      config: pool.config.toBase58(),
      creator: pool.creator.toBase58(),
      baseMint: pool.mint.toBase58(),
      quoteReserve: pool.quoteReserve.toString(),
      baseReserve: pool.baseReserve.toString(),
      migrationQuoteThreshold: this.threshold.toString(),
      progress: curveProgress(pool.quoteReserve, this.threshold),
      isMigrated: pool.isMigrated,
    };
  }

  private async send(
    method: FakeChainMethod,
    step: string,
    opts: SendOpts | undefined,
    tx: {
      from: PublicKey;
      to: PublicKey;
      amount: bigint;
      mint: PublicKey;
      pool?: FakePool;
      apply: () => void;
    },
  ): Promise<TxResult> {
    const failures = this.failures.get(method) ?? 0;
    if (failures > 0) {
      this.failures.set(method, failures - 1);
      throw new AppError('chain_send_failed', { cause: new Error(`fake failure: ${method}`) });
    }
    const signature = bs58.encode(randomBytes(64));
    this.blockHeight += 150;
    await opts?.onSigned?.(signature, this.blockHeight, step);
    if (this.crashBeforeLand.delete(method)) {
      throw new Error(`fake crash after signing ${method}`);
    }

    tx.apply();
    const row: FakeChainTx = {
      signature,
      method,
      from: tx.from.toBase58(),
      to: tx.to.toBase58(),
      amount: tx.amount.toString(),
      mint: tx.mint.toBase58(),
      settlementRef: opts?.settlementRef ?? null,
      ts: new Date(),
    };
    this.txs.push(row);
    await this.mongo?.collection(COLLECTION).insertOne(row);
    if (tx.pool?.persisted) await this.savePool(tx.pool);

    if (this.crashAfterLanding.delete(method)) {
      throw new Error(`fake crash after ${method} landed`);
    }
    return { signature };
  }
}

export function createFakeChain(opts: FakeChainOptions = {}): FakeChain {
  return new FakeChain(opts);
}
