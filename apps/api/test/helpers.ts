import { randomBytes } from 'node:crypto';

import { createFakeChain, type FakeChain } from '@ibt/chain/testing';
import { connection, connectDb, disconnectDb, mongoose, syncAllIndexes } from '@ibt/db';
import {
  CreateApiKeyResponseSchema,
  ErrorEnvelopeSchema,
  NonceResponseSchema,
  VerifyResponseSchema,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  type ErrorEnvelope,
} from '@ibt/shared';
import type { AlertLevel, Alerter } from '@ibt/shared/node';
import type { Express } from 'express';
import request from 'supertest';
import nacl from 'tweetnacl';
import { inject } from 'vitest';

import { createApp, type AppDeps } from '../src/app.js';
import { loadEnv, type ApiEnv } from '../src/env.js';
import { base58Encode } from '../src/lib/base58.js';

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

export interface TestWallet {
  keypair: nacl.SignKeyPair;
  wallet: string;
}

/** Ephemeral Ed25519 wallet; never a real key. */
export function newWallet(): TestWallet {
  const keypair = nacl.sign.keyPair();
  return { keypair, wallet: base58Encode(keypair.publicKey) };
}

/** Detached Ed25519 signature over `message`, base58 as a wallet adapter returns it. */
export function signMessage(keypair: nacl.SignKeyPair, message: string): string {
  return base58Encode(nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey));
}

let signInCounter = 0;
/** Distinct client IPs so helper sign-ins never trip the 10/min auth limit. */
function nextSignInIp(): string {
  signInCounter += 1;
  return `10.${(signInCounter >> 16) & 255}.${(signInCounter >> 8) & 255}.${signInCounter & 255}`;
}

export interface SignInOptions {
  /** Client IP sent as `X-Forwarded-For`; vary it to stay under the auth rate limit. */
  ip?: string;
}

/** Runs nonce → sign → verify and returns the JWT. */
export async function signIn(
  app: Express,
  keypair: nacl.SignKeyPair,
  opts: SignInOptions = {},
): Promise<string> {
  const wallet = base58Encode(keypair.publicKey);
  const ip = opts.ip ?? nextSignInIp();
  const nonceRes = await request(app)
    .post('/api/auth/nonce')
    .set('X-Forwarded-For', ip)
    .send({ wallet });
  if (nonceRes.status !== 200) throw new Error(`nonce failed: ${nonceRes.status}`);
  const { nonce, message } = NonceResponseSchema.parse(nonceRes.body);
  const verifyRes = await request(app)
    .post('/api/auth/verify')
    .set('X-Forwarded-For', ip)
    .send({ wallet, nonce, signature: signMessage(keypair, message) });
  if (verifyRes.status !== 200) throw new Error(`verify failed: ${verifyRes.status}`);
  return VerifyResponseSchema.parse(verifyRes.body).token;
}

/** `Authorization` header value for a JWT or API key. */
export function bearer(token: string): string {
  return `Bearer ${token}`;
}

/** `POST /api/keys` as the JWT's user; the response is the only place the full key appears. */
export async function createApiKey(
  app: Express,
  jwt: string,
  body: CreateApiKeyRequest = { name: 'test key' },
): Promise<CreateApiKeyResponse> {
  const res = await request(app).post('/api/keys').set('Authorization', bearer(jwt)).send(body);
  if (res.status !== 201) throw new Error(`create key failed: ${res.status}`);
  return CreateApiKeyResponseSchema.parse(res.body);
}
