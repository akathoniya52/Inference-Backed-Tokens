import { createFakeChain, type FakeChain, type FakeChainTx } from '@ibt/chain/testing';
import { FakePriceSource } from '@ibt/chain';
import { connection, connectDb, disconnectDb, syncAllIndexes } from '@ibt/db';
import { MIN_PAYOUT_MICRO, type IntLike } from '@ibt/shared';
import { createLogger, type Alerter, type AlertLevel } from '@ibt/shared/node';
import { Keypair } from '@solana/web3.js';
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
