import { randomBytes } from 'node:crypto';

import { createFakeChain, type FakeChain } from '@ibt/chain/testing';
import { connection, connectDb, disconnectDb, mongoose, syncAllIndexes } from '@ibt/db';
import { ErrorEnvelopeSchema, type ErrorEnvelope } from '@ibt/shared';
import type { AlertLevel, Alerter } from '@ibt/shared/node';
import type { Express } from 'express';
import { inject } from 'vitest';

import { createApp, type AppDeps } from '../src/app.js';
import { loadEnv, type ApiEnv } from '../src/env.js';

const WALLET = '11111111111111111111111111111111';

export interface RecordedAlert {
  level: AlertLevel;
  title: string;
  body: Record<string, unknown>;
}

export interface RecordingAlerter extends Alerter {
  readonly alerts: RecordedAlert[];
}

export interface TestClock {
  now(): Date;
  set(date: Date): void;
  advance(ms: number): void;
}

export interface TestApp {
  app: Express;
  chain: FakeChain;
  env: ApiEnv;
  alerter: RecordingAlerter;
  clock: TestClock;
  close(): Promise<void>;
}

export interface MakeTestAppOptions {
  /** Overrides merged into the default test env source. */
  env?: Record<string, string | undefined>;
  now?: Date;
  timeouts?: AppDeps['timeouts'];
  extraRoutes?: AppDeps['extraRoutes'];
}

export function createTestClock(start = new Date()): TestClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    set: (date) => {
      current = date.getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

export function createRecordingAlerter(): RecordingAlerter {
  const alerts: RecordedAlert[] = [];
  return {
    alerts,
    alert(level, title, body = {}) {
      alerts.push({ level, title, body });
      return Promise.resolve();
    },
  };
}

/** One database per test file: files run in parallel workers against one replica set. */
function testDbUri(): string {
  const url = new URL(inject('mongoUri'));
  url.pathname = `/api_${randomBytes(6).toString('hex')}`;
  return url.toString();
}

export function testEnvSource(mongoUri: string): Record<string, string> {
  return {
    CLUSTER: 'devnet',
    RPC_URL: 'http://127.0.0.1:8899',
    CHAIN_MODE: 'fake',
    USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    DBC_CONFIG: WALLET,
    TREASURY_WALLET: WALLET,
    KEEPER_WALLET: WALLET,
    MONGODB_URI: mongoUri,
    JWT_SECRET: randomBytes(32).toString('base64'),
    MASTER_KEY: randomBytes(32).toString('hex'),
    ADMIN_TOKEN: randomBytes(32).toString('base64'),
    WEB_ORIGIN: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
  };
}

let dbUri: string | undefined;
let openApps = 0;

/** Builds an app on a per-file Mongo database (indexes synced) with a fake chain. */
export async function makeTestApp(opts: MakeTestAppOptions = {}): Promise<TestApp> {
  if (dbUri === undefined) {
    dbUri = testDbUri();
    await connectDb(dbUri);
    await syncAllIndexes();
  }
  openApps += 1;
  const env = loadEnv({ ...testEnvSource(dbUri), ...opts.env });
  const chain = createFakeChain();
  const alerter = createRecordingAlerter();
  const clock = createTestClock(opts.now);
  const app = createApp({
    env,
    chain,
    alerter,
    clock: () => clock.now(),
    ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
    ...(opts.extraRoutes ? { extraRoutes: opts.extraRoutes } : {}),
  });
  let closed = false;
  return {
    app,
    chain,
    env,
    alerter,
    clock,
    async close() {
      if (closed) return;
      closed = true;
      openApps -= 1;
      if (openApps === 0 && connection.readyState === mongoose.ConnectionStates.connected) {
        await connection.dropDatabase();
        await disconnectDb();
        dbUri = undefined;
      }
    },
  };
}

/** The `error` object of an envelope response, validated. */
export function errorOf(res: { body: unknown }): ErrorEnvelope['error'] {
  return ErrorEnvelopeSchema.parse(res.body).error;
}
