// Local end-to-end smoke (work plan P9-T1, §9). Runs the whole local happy path against the
// compose mongo in a fresh `ibt_smoke_<timestamp>` database: mock upstream and api as child
// processes (CHAIN_MODE=fake), ephemeral sign-in, seed, API key, one gateway call, billing
// checks, then one keeper settlement through settle-once. Prints `ok: <step>` per step and
// `SMOKE OK`, or `SMOKE FAIL: <step>: <reason>` with exit 1.
//
// Env: SMOKE_ENV_FILE (loaded first, optional), SMOKE_API_PORT (4000), SMOKE_MOCK_PORT (4010),
// SMOKE_KEEP_DB=1 keeps the database. Secrets and keeper keys are generated per run.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { USDC_MINT } from '@ibt/chain';
import { ALL_MODELS, connectDb, connection, disconnectDb } from '@ibt/db';
import {
  CreateApiKeyResponseSchema,
  DAMM_V2_FEE_CONFIG,
  LedgerResponseSchema,
  MeResponseSchema,
  microToUsdcString,
  TokenStateResponseSchema,
  usdcStringToMicro,
} from '@ibt/shared';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import type { z } from 'zod';

import { signInEphemeral } from './dev-signin.js';
import { seedModels } from './seed-models.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const DEFAULT_MONGODB_URI = 'mongodb://localhost:27017/ibt?replicaSet=rs0&directConnection=true';
const DEFAULT_API_PORT = 4000;
const DEFAULT_MOCK_PORT = 4010;
const DEV_CREDIT_USDC = '10';
const MODEL_SLUG = 'mock-llm';
const HOUR_MS = 3_600_000;
const READY_TIMEOUT_MS = 90_000;
const SETTLE_TIMEOUT_MS = 120_000;
const ONE_USDC_MICRO = 1_000_000n;
const TAIL_BYTES = 4_000;

class SmokeError extends Error {
  constructor(
    readonly step: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'SmokeError';
  }
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    console.log(`ok: ${name}`);
    return result;
  } catch (err) {
    if (err instanceof SmokeError) throw err;
    throw new SmokeError(name, err instanceof Error ? err.message : String(err));
  }
}

function assert(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Like `sleep`, but never keeps the process alive once everything else is done. */
const deadline = (ms: number) =>
  new Promise<'timeout'>((resolve) => setTimeout(resolve, ms, 'timeout').unref());

/** Something already answers on `host:port` (a bind test alone misses IPv4-only listeners). */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(1_000);
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function portFree(port: number): Promise<boolean> {
  const taken = await Promise.all([answers('127.0.0.1', port), answers('::1', port)]);
  return !taken.some(Boolean) && (await canListen(port));
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function pickPort(label: string, envName: string, fallback: number): Promise<number> {
  const raw = process.env[envName]?.trim();
  const wanted = raw ? Number(raw) : fallback;
  if (!Number.isInteger(wanted) || wanted <= 0 || wanted > 65_535) {
    throw new Error(`${envName} must be a TCP port`);
  }
  if (await portFree(wanted)) return wanted;
  if (raw) throw new Error(`${envName}=${wanted} is already in use`);
  const port = await freePort();
  console.log(`${label} port ${wanted} is busy; using ${port}`);
  return port;
}

// ---- child processes ---------------------------------------------------------------------

interface Child {
  name: string;
  proc: ChildProcess;
  output: () => string;
  stdout: () => string;
  exited: Promise<number | null>;
}

const children = new Set<Child>();

/**
 * `tsx --conditions=development <entry>` in `pkgDir`, as its own process group so tsx and the
 * node it starts stop together. tsx runs directly: `pnpm exec` puts it in a separate group.
 */
function startTsx(name: string, pkgDir: string, args: string[], env: NodeJS.ProcessEnv): Child {
  const proc = spawn(process.execPath, [TSX_CLI, '--conditions=development', ...args], {
    cwd: join(REPO_ROOT, pkgDir),
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tail = '';
  const keep = (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-TAIL_BYTES);
  };
  let stdout = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    keep(chunk);
  });
  proc.stderr?.on('data', keep);
  const exited = new Promise<number | null>((resolve) => {
    proc.once('error', (err) => {
      tail += `\nspawn failed: ${err.message}`;
      resolve(null);
    });
    proc.once('exit', (code) => resolve(code));
  });
  const child: Child = { name, proc, output: () => tail, stdout: () => stdout, exited };
  children.add(child);
  void exited.then(() => children.delete(child));
  return child;
}

function signalGroup(child: Child, signal: NodeJS.Signals): void {
  const pid = child.proc.pid;
  if (pid === undefined || child.proc.exitCode !== null) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    // ESRCH: the group is already gone.
    if (!(err instanceof Error && 'code' in err && err.code === 'ESRCH')) throw err;
  }
}

async function stopChild(child: Child): Promise<void> {
  signalGroup(child, 'SIGTERM');
  const stopped = await Promise.race([
    child.exited.then(() => true),
    deadline(5_000).then(() => false),
  ]);
  if (!stopped) signalGroup(child, 'SIGKILL');
}

async function stopAll(): Promise<void> {
  await Promise.all([...children].map(stopChild));
}

process.once('exit', () => {
  for (const child of children) signalGroup(child, 'SIGKILL');
});

async function waitReady(child: Child, url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error(`${child.name} exited early:\n${child.output()}`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (_err) {
      // Not listening yet; poll again.
    }
    await sleep(250);
  }
  throw new Error(
    `${child.name} not ready at ${url} after ${READY_TIMEOUT_MS} ms:\n${child.output()}`,
  );
}

async function getJson<S extends z.ZodType>(
  url: string,
  bearer: string,
  schema: S,
): Promise<z.output<S>> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
  const text = await res.text();
  assert(
    res.status === 200,
    `GET ${new URL(url).pathname} → HTTP ${res.status}: ${text.slice(0, 300)}`,
  );
  return schema.parse(JSON.parse(text));
}

interface SettleSummary {
  chain: string;
  periodStart: string;
  settlements: {
    model: string;
    state?: string;
    error?: string | null;
    providerCarryOverMicroUsdc?: string;
    liquidity?: { phase: string; solLamports: string | null; buyTx: string | null };
  }[];
}

async function settleOnce(env: NodeJS.ProcessEnv, periodStart: Date): Promise<SettleSummary> {
  // tsx directly, not `pnpm settle:once -- …`: that script loads apps/keeper/.env, and a literal
  // `--` would make settle-once's parseArgs read `--chain` as a positional.
  const child = startTsx(
    'settle-once',
    'apps/keeper',
    ['src/cli/settle-once.ts', '--chain', 'fake', '--period-start', periodStart.toISOString()],
    env,
  );
  const code = await Promise.race([child.exited, deadline(SETTLE_TIMEOUT_MS)]);
  if (code === 'timeout') {
    await stopChild(child);
    throw new Error(`settle-once timed out after ${SETTLE_TIMEOUT_MS} ms:\n${child.output()}`);
  }
  assert(code === 0, `settle-once exited ${String(code)}:\n${child.output()}`);
  const line = child
    .stdout()
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('{'));
  assert(line !== undefined, `settle-once printed no JSON summary:\n${child.output()}`);
  return JSON.parse(line) as SettleSummary;
}

function freshMongoUri(base: string): { uri: string; dbName: string } {
  const url = new URL(base);
  const dbName = `ibt_smoke_${Date.now()}`;
  url.pathname = `/${dbName}`;
  return { uri: url.toString(), dbName };
}

const secret = () => randomBytes(32).toString('hex');

let mongoUri: string | null = null;
let dbName = '';

async function dropDatabase(): Promise<void> {
  if (mongoUri === null) return;
  if (process.env.SMOKE_KEEP_DB === '1') {
    console.log(`kept database ${dbName} (SMOKE_KEEP_DB=1)`);
    return;
  }
  await connectDb(mongoUri);
  try {
    // Reconnecting re-runs model init (collection + index creation); finish it first or it
    // recreates collections right after the drop.
    await Promise.all(ALL_MODELS.map((model) => model.init()));
    await connection.db?.dropDatabase();
  } finally {
    await disconnectDb();
  }
}

async function cleanup(): Promise<void> {
  await stopAll();
  try {
    await dropDatabase();
  } catch (err) {
    console.error(
      `warning: could not drop ${dbName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function smoke(): Promise<void> {
  const envFile = process.env.SMOKE_ENV_FILE?.trim();
  if (envFile) {
    await step(`load ${envFile}`, () => {
      process.loadEnvFile(envFile);
      return Promise.resolve();
    });
  }

  const { apiPort, mockPort } = await step('pick ports', async () => {
    const api = await pickPort('api', 'SMOKE_API_PORT', DEFAULT_API_PORT);
    const mock = await pickPort('mock upstream', 'SMOKE_MOCK_PORT', DEFAULT_MOCK_PORT);
    assert(api !== mock, 'api and mock upstream ports must differ');
    console.log(`  api :${api}, mock upstream :${mock}`);
    return { apiPort: api, mockPort: mock };
  });
  const apiUrl = `http://localhost:${apiPort}`;

  const fresh = freshMongoUri(process.env.MONGODB_URI?.trim() || DEFAULT_MONGODB_URI);
  mongoUri = fresh.uri;
  dbName = fresh.dbName;
  console.log(`  database ${dbName}`);

  const keeperKey = Keypair.generate();
  const treasuryKey = Keypair.generate();
  const {
    KEEPER_SECRET_KEY: _keeperSecret,
    TREASURY_SECRET_KEY: _treasurySecret,
    ...inherited
  } = process.env;
  const apiEnv: NodeJS.ProcessEnv = {
    ...inherited,
    CHAIN_MODE: 'fake',
    CLUSTER: 'devnet',
    RPC_URL: inherited.RPC_URL?.trim() || 'https://api.devnet.solana.com',
    USDC_MINT: USDC_MINT.devnet.toBase58(),
    DBC_CONFIG: inherited.DBC_CONFIG?.trim() || Keypair.generate().publicKey.toBase58(),
    TREASURY_WALLET: treasuryKey.publicKey.toBase58(),
    KEEPER_WALLET: keeperKey.publicKey.toBase58(),
    MONGODB_URI: mongoUri,
    JWT_SECRET: secret(),
    MASTER_KEY: secret(),
    ADMIN_TOKEN: secret(),
    WEB_ORIGIN: inherited.WEB_ORIGIN?.trim() || 'http://localhost:5173',
    LOG_LEVEL: 'warn',
    PORT: String(apiPort),
    MOCK_UPSTREAM_PORT: String(mockPort),
  };
  const keeperEnv: NodeJS.ProcessEnv = {
    ...apiEnv,
    DAMM_V2_FEE_CONFIG,
    KEEPER_SECRET_KEY: bs58.encode(keeperKey.secretKey),
    TREASURY_SECRET_KEY: bs58.encode(treasuryKey.secretKey),
    API_INTERNAL_URL: apiUrl,
    JUPITER_PRICE_URL: inherited.JUPITER_PRICE_URL?.trim() || 'https://lite-api.jup.ag/price/v3',
  };

  await step('start mock upstream', async () => {
    const mock = startTsx('mock-upstream', 'apps/mock-upstream', ['src/main.ts'], apiEnv);
    await waitReady(mock, `http://localhost:${mockPort}/healthz`);
  });
  await step('start api', async () => {
    const api = startTsx('api', 'apps/api', ['src/main.ts'], apiEnv);
    await waitReady(api, `${apiUrl}/readyz`);
  });

  const { wallet, jwt } = await step('dev sign-in', () => signInEphemeral({ apiUrl }));
  const seeded = await step('seed models', () =>
    seedModels({
      owner: wallet,
      fakeToken: true,
      devCredit: { wallet, usdc: DEV_CREDIT_USDC },
      env: apiEnv,
    }),
  );
  const mint = seeded.fakeToken?.mint;
  const modelId = seeded.models.find((m) => m.slug === MODEL_SLUG)?.id;

  const apiKey = await step('create api key', async () => {
    const res = await fetch(`${apiUrl}/api/keys`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'smoke' }),
    });
    const text = await res.text();
    assert(res.status === 201 || res.status === 200, `HTTP ${res.status}: ${text.slice(0, 300)}`);
    return CreateApiKeyResponseSchema.parse(JSON.parse(text)).key;
  });

  const balanceBefore = await step('balance before', async () => {
    const me = await getJson(`${apiUrl}/api/me`, jwt, MeResponseSchema);
    const micro = usdcStringToMicro(me.balanceUsdc);
    assert(micro === usdcStringToMicro(DEV_CREDIT_USDC), `balance ${me.balanceUsdc}, want 10`);
    return micro;
  });

  const requestedAt = new Date();
  const costMicro = await step('chat completion', async () => {
    const res = await fetch(`${apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_SLUG,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 64,
      }),
    });
    const text = await res.text();
    assert(res.status === 200, `HTTP ${res.status}: ${text.slice(0, 300)}`);
    const cost = res.headers.get('x-cost-usdc');
    const balance = res.headers.get('x-balance-usdc');
    assert(cost !== null, 'X-Cost-Usdc header missing');
    assert(balance !== null, 'X-Balance-Usdc header missing');
    const micro = usdcStringToMicro(cost);
    assert(micro > 0n, `X-Cost-Usdc is ${cost}`);
    assert(usdcStringToMicro(balance) < balanceBefore, `X-Balance-Usdc ${balance} is not < 10`);
    console.log(`  X-Cost-Usdc ${cost}, X-Balance-Usdc ${balance}`);
    return micro;
  });

  await step('ledger has captured hold and capture rows', async () => {
    const { items } = await getJson(`${apiUrl}/api/billing/ledger`, jwt, LedgerResponseSchema);
    const hold = items.find((row) => row.type === 'hold');
    assert(hold?.status === 'captured', `hold row status ${hold?.status ?? 'missing'}`);
    assert(
      items.some((row) => row.type === 'capture'),
      `no capture row (types: ${items.map((r) => r.type).join(', ')})`,
    );
  });

  await step('balance dropped by the cost', async () => {
    const me = await getJson(`${apiUrl}/api/me`, jwt, MeResponseSchema);
    const want = balanceBefore - costMicro;
    assert(
      usdcStringToMicro(me.balanceUsdc) === want,
      `balance ${me.balanceUsdc}, want ${microToUsdcString(want)}`,
    );
  });

  await step('token state on the curve', async () => {
    assert(mint !== undefined, 'seed-models returned no fake token');
    const state = await getJson(
      `${apiUrl}/api/tokens/${mint}/state`,
      jwt,
      TokenStateResponseSchema,
    );
    assert(state.phase === 'curve', `phase ${state.phase}`);
  });

  const periodStart = new Date(Math.floor(requestedAt.getTime() / HOUR_MS) * HOUR_MS);
  await step(`keeper settle-once ${periodStart.toISOString()}`, async () => {
    const summary = await settleOnce(keeperEnv, periodStart);
    assert(summary.chain === 'fake', `chain ${summary.chain}`);
    assert(
      summary.settlements.length === 1,
      `${summary.settlements.length} settlements: ${JSON.stringify(summary.settlements)}`,
    );
    const [s] = summary.settlements;
    assert(
      s?.model === MODEL_SLUG,
      `settled ${s?.model ?? 'nothing'} (model id ${modelId ?? '?'})`,
    );
    assert(s.state === 'done', `state ${s.state ?? '?'}, error ${s.error ?? 'none'}`);
    const carry = BigInt(s.providerCarryOverMicroUsdc ?? '0');
    assert(carry > 0n && carry < ONE_USDC_MICRO, `provider carry-over ${carry} micro-USDC`);
    const liq = s.liquidity;
    assert(liq?.phase === 'curve', `liquidity phase ${liq?.phase ?? '?'}`);
    assert(BigInt(liq.solLamports ?? '0') > 0n, `solLamports ${liq.solLamports ?? 'null'}`);
    assert(liq.buyTx !== null, 'no curve buy signature');
    console.log(
      `  carry-over ${microToUsdcString(carry)} USDC, ${liq.solLamports} lamports, buy ${liq.buyTx}`,
    );
  });

  await step('fake chain recorded one curve buy', async () => {
    assert(mongoUri !== null, 'no database');
    await connectDb(mongoUri);
    try {
      const db = connection.db;
      assert(db !== undefined, 'not connected');
      const buys = await db.collection('fakeChainTxs').countDocuments({ method: 'curveBuy' });
      assert(buys === 1, `${buys} curveBuy rows in fakeChainTxs`);
    } finally {
      await disconnectDb();
    }
  });
}

let interrupted = false;
process.once('SIGINT', () => {
  interrupted = true;
  console.log('SMOKE FAIL: interrupted: SIGINT');
  void cleanup().finally(() => process.exit(130));
});

try {
  await smoke();
  await cleanup();
  console.log('SMOKE OK');
} catch (err) {
  if (!interrupted) {
    const where = err instanceof SmokeError ? err.step : 'smoke';
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`SMOKE FAIL: ${where}: ${reason}`);
    await cleanup();
    process.exitCode = 1;
  }
}
