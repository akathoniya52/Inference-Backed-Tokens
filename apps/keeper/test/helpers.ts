import { createFakeChain, type FakeChain, type FakeChainTx } from '@ibt/chain/testing';
import { FakePriceSource } from '@ibt/chain';
import {
  Models,
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
