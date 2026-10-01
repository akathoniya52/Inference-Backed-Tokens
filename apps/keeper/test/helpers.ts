import { createFakeChain, type FakeChain, type FakeChainTx } from '@ibt/chain/testing';
import { FakePriceSource, deriveDammPool } from '@ibt/chain';
import {
  Models,
  Requests,
  Types,
  Users,
  connection,
  connectDb,
  disconnectDb,
  syncAllIndexes,
  type ModelDoc,
} from '@ibt/db';
import { MIN_PAYOUT_MICRO, type IntLike } from '@ibt/shared';
import { createLogger, type Alerter, type AlertLevel } from '@ibt/shared/node';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { inject } from 'vitest';

import type { Clock, KeeperConfig, KeeperCtx } from '../src/ctx.js';

export interface FakeClock extends Clock {
  set(date: Date | string): void;
  advance(ms: number): void;
}

export function createFakeClock(start: Date | string = '2026-01-01T00:00:00Z'): FakeClock {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    set: (date) => {
      current = new Date(date).getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

export interface RecordedAlert {
  level: AlertLevel;
  title: string;
  body: Record<string, unknown>;
}

export interface FakeAlerter extends Alerter {
  alerts: RecordedAlert[];
}

export function createFakeAlerter(): FakeAlerter {
  const alerts: RecordedAlert[] = [];
  return {
    alerts,
    alert(level, title, body = {}) {
      alerts.push({ level, title, body });
      return Promise.resolve();
    },
  };
}

export interface TestKeeperCtx extends KeeperCtx {
  db: typeof connection;
  chain: FakeChain;
  price: FakePriceSource;
  clock: FakeClock;
  alerter: FakeAlerter;
  keeper: Keypair;
  treasury: Keypair;
  /** Value returned by `blockHeight()`; the default treats every unlanded `pendingTx` as expired. */
  setBlockHeight(height: number): void;
  close(): Promise<void>;
}

export const USDC = 1_000_000n;

export const micro = (usdc: IntLike): bigint => BigInt(usdc) * USDC;

let seq = 0;

export interface TestModel {
  model: ModelDoc;
  providerWallet: PublicKey;
  mint: PublicKey;
  pool: PublicKey | null;
}

/** A provider plus a model; `phase` other than `none` also registers a DBC pool on the fake chain. */
export async function createTestModel(
  ctx: TestKeeperCtx,
  phase: 'none' | 'curve' = 'none',
): Promise<TestModel> {
  seq += 1;
  const providerWallet = Keypair.generate().publicKey;
  const provider = await Users.create({
    wallet: providerWallet.toBase58(),
    role: 'provider',
    depositRef: `KP${String(seq).padStart(6, '0')}`,
  });
  const mint = Keypair.generate().publicKey;
  const pool =
    phase === 'curve'
      ? ctx.chain.addPool({ mint, config: Keypair.generate().publicKey, creator: providerWallet })
      : null;
  const model = await Models.create({
    providerId: provider._id,
    slug: `model-${seq}`,
    name: `Model ${seq}`,
    upstream: { baseUrl: 'http://127.0.0.1:4010', modelName: 'mock', apiKeyEnc: 'enc' },
    pricing: { inputPerMTokMicroUsdc: 1_000_000n, outputPerMTokMicroUsdc: 2_000_000n },
    token: pool
      ? { status: 'curve', mint: mint.toBase58(), dbcPool: pool.toBase58(), symbol: `T${seq}` }
      : {},
  });
  return { model, providerWallet, mint, pool };
}

let reqSeq = 0;

/** A request row with an explicit `createdAt` (timestamps off). */
export async function addRequest(
  modelId: Types.ObjectId,
  cost: bigint,
  createdAt: Date,
  status: 'success' | 'upstream_error' = 'success',
): Promise<void> {
  reqSeq += 1;
  await new Requests({
    userId: new Types.ObjectId(),
    apiKeyId: new Types.ObjectId(),
    modelId,
    requestId: `req-h-${reqSeq}-${Math.random().toString(36).slice(2, 8)}`,
    status,
    costMicroUsdc: cost,
    createdAt,
  }).save({ timestamps: false });
}

/** Default fake-chain curve threshold (`FakeChain.migrateWhen`). */
export const DEFAULT_THRESHOLD = 10_000_000_000n;

/** Migrates a curve model's fake pool to DAMM v2 and marks the token graduated. */
export async function graduate(ctx: TestKeeperCtx, { model, mint, pool }: TestModel) {
  if (!pool) throw new Error('graduate needs a curve model');
  ctx.chain.migrateWhen(0n);
  try {
    await ctx.chain.migrate(ctx.keeper, pool);
  } finally {
    ctx.chain.migrateWhen(DEFAULT_THRESHOLD);
  }
  await Models.updateOne(
    { _id: model._id },
    { $set: { 'token.status': 'graduated', 'token.dammV2Pool': deriveDammPool(mint).toBase58() } },
  );
}

/** Connects `@ibt/db` to a fresh database on the shared replica set (one per test file). */
export async function makeKeeperCtx(
  overrides: { config?: Partial<KeeperConfig>; solUsd?: number } = {},
): Promise<TestKeeperCtx> {
  const url = new URL(inject('mongoUri'));
  url.pathname = `/keeper_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await connectDb(url.toString());
  await syncAllIndexes();

  const db = connection.db;
  if (!db) throw new Error('mongoose connection has no db handle');
  const price = new FakePriceSource(overrides.solUsd ?? 150);
  const chain = createFakeChain({
    priceSource: price,
    mongo: { collection: (name) => db.collection<FakeChainTx>(name) },
  });
  let height = Number.MAX_SAFE_INTEGER;

  return {
    db: connection,
    chain,
    price,
    clock: createFakeClock(),
    logger: createLogger({ level: 'silent', name: 'keeper-test' }),
    alerter: createFakeAlerter(),
    keeper: Keypair.generate(),
    treasury: Keypair.generate(),
    config: {
      minPayoutMicroUsdc: MIN_PAYOUT_MICRO,
      maxPayoutMicroUsdc: micro(500),
      maxSliceLamports: 2_000_000_000n,
      pendingTxPollMs: 1,
      pendingTxMaxPolls: 3,
      ...overrides.config,
    },
    blockHeight: () => Promise.resolve(height),
    sleep: () => Promise.resolve(),
    setBlockHeight: (next) => {
      height = next;
    },
    close: async () => {
      await db.dropDatabase();
      await disconnectDb();
    },
  };
}
