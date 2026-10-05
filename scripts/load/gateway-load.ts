// Gateway load test (work plan P8-T6, spec L591): seeds keys with dev credit in a fresh local
// database, starts the mock upstream and the api as children, drives POST /v1/chat/completions
// at a fixed rate round-robin across the keys, repeats the profile directly against the mock as
// the baseline, then checks the ledger. Exits 0 only when every threshold passes.
// Local only (G23): refused on mainnet-beta and against any non-localhost MONGODB_URI.
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectDb, connection, disconnectDb } from '@ibt/db';
import { DEFAULT_MOCK_API_KEY } from '@ibt/mock-upstream';
import { USDC_MINT, usdcStringToMicro } from '@ibt/shared';
import { Keypair } from '@solana/web3.js';

import { CliError, EXIT_ERROR, EXIT_OK, EXIT_REFUSED, runMain } from '../lib/cli.js';
import { checkLedger, type LedgerChecks, waitForOpenHolds } from './checks.js';
import { type LoadProfile, roundMs, runLoad, type RunSummary } from './measure.js';
import { type Child, startTsx, waitForOk } from './processes.js';
import { LOAD_MODEL_SLUG, LOAD_UPSTREAM_MODEL, seedLoadData } from './seed.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COMPOSE_MONGO_URI = 'mongodb://localhost:27017/ibt?replicaSet=rs0&directConnection=true';
const LOCAL_MONGO_HOSTS = new Set(['localhost', '127.0.0.1']);
const CHAT_PATH = '/v1/chat/completions';
const READY_TIMEOUT_MS = 60_000;
const HOLD_DRAIN_TIMEOUT_MS = 15_000;
/** Plan L611: limits raised so only the gateway path is measured. */
const RATE_LIMIT_PER_MIN = '100000';
const DAILY_CAP_USDC = '1000000';
const CREDIT_USDC = '1000';
const MIN_RATE_FRACTION = 0.9;
/**
 * autocannon sends each connection's per-second quota back to back at the top of the second, so
 * this is the peak concurrency of every burst, not a pacing knob. At 50 req/s and a ~15 ms gateway
 * path the steady-state concurrency is about 1; 5 keeps the bursts pessimistic but realistic.
 */
const DEFAULT_CONNECTIONS = 5;

export interface LoadConfig {
  apiPort: number;
  mockPort: number;
  users: number;
  profile: LoadProfile;
  warmupS: number;
  maxOverheadP95Ms: number;
  keepDb: boolean;
  mongoUri: string;
  dbName: string;
  cluster: string;
  logLevel: string;
}

function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new CliError(`${name} must be an integer >= ${min}`);
  }
  return value;
}

function mongoHost(uri: string): string | null {
  try {
    return new URL(uri).hostname;
  } catch (_err) {
    // Multi-host seed lists are not valid URLs; they are never local.
    return null;
  }
}

/** Same host, options and replica set as `base`, but always the fresh `dbName`. */
export function freshDbUri(base: string, dbName: string): string {
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** G23: runs before any connection, spawn or write. */
export function assertLocalOnly(cluster: string, uri: string): void {
  if (cluster === 'mainnet-beta') {
    throw new CliError('refusing: CLUSTER is mainnet-beta; nothing was written', EXIT_REFUSED);
  }
  const host = mongoHost(uri);
  if (host === null || !LOCAL_MONGO_HOSTS.has(host)) {
    throw new CliError(
      `refusing: MONGODB_URI host ${host ?? '<unparseable>'} is not localhost or 127.0.0.1; ` +
        'nothing was written',
      EXIT_REFUSED,
    );
  }
}

export function loadConfig(): LoadConfig {
  const envFile = process.env.LOAD_ENV_FILE?.trim();
  if (envFile) process.loadEnvFile(envFile);

  const cluster = process.env.CLUSTER?.trim() || 'devnet';
  const baseUri = process.env.MONGODB_URI?.trim() || COMPOSE_MONGO_URI;
  assertLocalOnly(cluster, baseUri);
  const dbName = `ibt_load_${Date.now()}`;

  return {
    apiPort: intEnv('LOAD_API_PORT', 4200, 1),
    mockPort: intEnv('LOAD_MOCK_PORT', 4210, 1),
    users: intEnv('LOAD_USERS', 60, 50),
    profile: {
      ratePerSec: intEnv('LOAD_RATE', 50, 1),
      durationS: intEnv('LOAD_DURATION_S', 60, 1),
      connections: intEnv('LOAD_CONNECTIONS', DEFAULT_CONNECTIONS, 1),
    },
    warmupS: intEnv('LOAD_WARMUP_S', 3, 0),
    maxOverheadP95Ms: intEnv('LOAD_MAX_OVERHEAD_P95_MS', 50, 1),
    keepDb: process.env.LOAD_KEEP_DB === '1',
    mongoUri: freshDbUri(baseUri, dbName),
    dbName,
    cluster,
    logLevel: process.env.LOG_LEVEL?.trim() || 'warn',
  };
}

const secret = (): string => randomBytes(32).toString('base64');
const randomWallet = (): string => Keypair.generate().publicKey.toBase58();

function baseChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function apiEnv(cfg: LoadConfig, masterKey: string): Record<string, string> {
  return {
    ...baseChildEnv(),
    CLUSTER: cfg.cluster,
    CHAIN_MODE: 'fake',
    RPC_URL: 'http://127.0.0.1:8899',
    USDC_MINT: USDC_MINT.devnet,
    DBC_CONFIG: randomWallet(),
    TREASURY_WALLET: randomWallet(),
    KEEPER_WALLET: randomWallet(),
    MONGODB_URI: cfg.mongoUri,
    JWT_SECRET: secret(),
    MASTER_KEY: masterKey,
    ADMIN_TOKEN: secret(),
    PORT: String(cfg.apiPort),
    WEB_ORIGIN: 'http://localhost:5173',
    RATE_LIMIT_PER_MIN,
    DAILY_CAP_USDC,
    MOCK_UPSTREAM_PORT: String(cfg.mockPort),
    ALLOW_PRIVATE_UPSTREAMS: 'true',
    LOG_LEVEL: cfg.logLevel,
  };
}

interface Verdict {
  name: string;
  pass: boolean;
  value: number;
  limit: string;
}

export function evaluate(
  cfg: LoadConfig,
  api: RunSummary,
  mock: RunSummary,
  ledger: LedgerChecks,
): Verdict[] {
  const overhead = roundMs(api.latencyMs.p95 - mock.latencyMs.p95);
  const expected = cfg.profile.ratePerSec * cfg.profile.durationS;
  const check = (name: string, value: number, pass: boolean, limit: string): Verdict => ({
    name,
    value,
    pass,
    limit,
  });
  return [
    check('overheadP95Ms', overhead, overhead < cfg.maxOverheadP95Ms, `< ${cfg.maxOverheadP95Ms}`),
    check('apiNon2xx', api.non2xx, api.non2xx === 0, '0'),
    check('apiErrors', api.errors, api.errors === 0, '0'),
    check('apiRequests', api.requests, api.requests >= expected * MIN_RATE_FRACTION, `>= 90%`),
    check(
      'baselineNon2xxOrErrors',
      mock.non2xx + mock.errors,
      mock.non2xx + mock.errors === 0,
      '0',
    ),
    check('negativeBalances', ledger.negativeBalances, ledger.negativeBalances === 0, '0'),
    check('negativeAvailable', ledger.negativeAvailable, ledger.negativeAvailable === 0, '0'),
    check('duplicateCaptures', ledger.duplicateCaptures, ledger.duplicateCaptures === 0, '0'),
    check('stuckHolds', ledger.openHolds, ledger.openHolds === 0, '0'),
    check('nonZeroHeld', ledger.nonZeroHeld, ledger.nonZeroHeld === 0, '0'),
    check('balanceDrift', ledger.balanceDrift, ledger.balanceDrift === 0, '0'),
  ];
}

const chatBody = (model: string): string =>
  JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 64 });

async function run(cfg: LoadConfig, children: Child[]): Promise<number> {
  const masterKey = secret();
  const keys = await seedLoadData({
    users: cfg.users,
    creditMicro: usdcStringToMicro(CREDIT_USDC),
    dailyCapMicro: usdcStringToMicro(DAILY_CAP_USDC),
    masterKey,
    mockPort: cfg.mockPort,
  });
  console.error(`seeded ${keys.length} users/keys in ${cfg.dbName}`);

  const mockUrl = `http://127.0.0.1:${cfg.mockPort}`;
  const mock = startTsx('mock', resolve(REPO_ROOT, 'apps/mock-upstream'), 'src/main.ts', {
    ...baseChildEnv(),
    MOCK_UPSTREAM_PORT: String(cfg.mockPort),
  });
  children.push(mock);
  await waitForOk(`${mockUrl}/healthz`, mock, READY_TIMEOUT_MS);

  const apiUrl = `http://127.0.0.1:${cfg.apiPort}`;
  const api = startTsx(
    'api',
    resolve(REPO_ROOT, 'apps/api'),
    'src/main.ts',
    apiEnv(cfg, masterKey),
  );
  children.push(api);
  await waitForOk(`${apiUrl}/readyz`, api, READY_TIMEOUT_MS);
  console.error(`mock on :${cfg.mockPort}, api on :${cfg.apiPort}; ready`);

  const runTag = Date.now().toString(36);
  let seq = 0;
  const apiTarget = {
    url: apiUrl,
    path: CHAT_PATH,
    body: chatBody(LOAD_MODEL_SLUG),
    headers: () => {
      const key = keys[seq % keys.length];
      seq += 1;
      if (!key) throw new Error('no seeded keys');
      return {
        'content-type': 'application/json',
        authorization: `Bearer ${key.key}`,
        'x-request-id': `load-${runTag}-${seq}`,
      };
    },
  };
  const mockTarget = {
    url: mockUrl,
    path: CHAT_PATH,
    body: chatBody(LOAD_UPSTREAM_MODEL),
    headers: () => ({
      'content-type': 'application/json',
      authorization: `Bearer ${DEFAULT_MOCK_API_KEY}`,
    }),
  };
  const warmup = { ...cfg.profile, durationS: cfg.warmupS };

  if (cfg.warmupS > 0) await runLoad(apiTarget, warmup);
  console.error(`api: ${cfg.profile.ratePerSec} req/s for ${cfg.profile.durationS} s`);
  const apiRun = await runLoad(apiTarget, cfg.profile);
  const openAfterDrain = await waitForOpenHolds(HOLD_DRAIN_TIMEOUT_MS);

  if (cfg.warmupS > 0) await runLoad(mockTarget, warmup);
  console.error(`mock baseline: ${cfg.profile.ratePerSec} req/s for ${cfg.profile.durationS} s`);
  const mockRun = await runLoad(mockTarget, cfg.profile);

  const ledger = await checkLedger();
  const verdicts = evaluate(cfg, apiRun, mockRun, ledger);
  const failed = verdicts.filter((v) => !v.pass);

  const summary = {
    db: cfg.dbName,
    profile: { ...cfg.profile, warmupS: cfg.warmupS, users: keys.length },
    api: apiRun,
    mock: mockRun,
    overheadMs: {
      p50: roundMs(apiRun.latencyMs.p50 - mockRun.latencyMs.p50),
      p95: roundMs(apiRun.latencyMs.p95 - mockRun.latencyMs.p95),
      p99: roundMs(apiRun.latencyMs.p99 - mockRun.latencyMs.p99),
    },
    ledger: { ...ledger, openHoldsAfterDrain: openAfterDrain },
    thresholds: verdicts,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    failed.length === 0
      ? `PASS: overhead p95 ${summary.overheadMs.p95} ms < ${cfg.maxOverheadP95Ms} ms, ` +
          `${apiRun.requests} requests, 0 non-2xx, ledger clean`
      : `FAIL: ${failed.map((v) => `${v.name}=${v.value} (want ${v.limit})`).join(', ')}`,
  );
  return failed.length === 0 ? EXIT_OK : EXIT_REFUSED;
}

async function cleanup(cfg: LoadConfig, children: Child[], connected: boolean): Promise<void> {
  // The api goes first so nothing writes while the database is dropped.
  for (const child of [...children].reverse()) await child.stop();
  if (!connected) return;
  try {
    if (cfg.keepDb) {
      console.error(`kept database ${cfg.dbName} (LOAD_KEEP_DB=1)`);
    } else {
      await connection.db?.dropDatabase();
      console.error(`dropped database ${cfg.dbName}`);
    }
  } finally {
    await disconnectDb();
  }
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const children: Child[] = [];
  let connected = false;
  let cleaning: Promise<void> | null = null;
  const cleanupOnce = (): Promise<void> => (cleaning ??= cleanup(cfg, children, connected));

  const onSignal = (signal: NodeJS.Signals): void => {
    console.error(`${signal}: stopping children`);
    cleanupOnce().then(
      () => process.exit(130),
      (err: unknown) => {
        console.error('cleanup failed:', err instanceof Error ? err.message : String(err));
        process.exit(EXIT_ERROR);
      },
    );
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await connectDb(cfg.mongoUri, { serverSelectionTimeoutMS: 5_000 });
    connected = true;
    return await run(cfg, children);
  } finally {
    await cleanupOnce();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) runMain(main);
