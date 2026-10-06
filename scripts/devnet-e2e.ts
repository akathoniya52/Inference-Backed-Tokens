// Devnet end-to-end run (work plan P8-T4, Plan.md L590, operator task H6). Skipped unless
// DEVNET_E2E=1. Every keypair is generated in memory for this run and never written anywhere;
// the keeper child receives its two keys through its environment only.
//
// Airdrops never use RPC_URL: Helius devnet answers requestAirdrop with HTTP 500. They go to
// AIRDROP_RPC_URL (default api.devnet.solana.com), whose faucet has a daily limit per IP; when it
// is dry, a wallet funded at https://faucet.solana.com and passed as DEVNET_FUNDER_SECRET_KEY funds
// the throwaway wallets by transfer instead.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildClaimPositionFee,
  buildCreateConfigTx,
  buildPartnerConfigParams,
  CpAmm,
  DBC_PROGRAM_ID,
  deriveDammPool,
  DynamicBondingCurveClient,
  readDammPool,
  RealChainClient,
  sendAndConfirm,
  USDC_MINT,
} from '@ibt/chain';
import {
  ALL_MODELS,
  connectDb,
  connection as mongoConnection,
  disconnectDb,
  Models,
  Requests,
  Settlements,
  syncAllIndexes,
  Types,
  Users,
} from '@ibt/db';
import { lamportsToSol } from '@ibt/shared';
import { generateDepositRef } from '@ibt/shared/node';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

import {
  assertRpcCluster,
  CliError,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_REFUSED,
  readSecretKeypair,
  runMain,
} from './lib/cli.js';

const DEVNET_PUBLIC_RPC = 'https://api.devnet.solana.com';
const DEFAULT_MONGODB_URI = 'mongodb://localhost:27017/ibt?replicaSet=rs0&directConnection=true';
const E2E_DB_PREFIX = 'ibt_devnet_e2e_';
const DEFAULT_JUPITER_PRICE_URL = 'https://lite-api.jup.ag/price/v3';
const KEEPER_ENV_FILE = fileURLToPath(new URL('../apps/keeper/.env', import.meta.url));
const HOUR_MS = 3_600_000;
const SLIPPAGE_BPS = 500;
/** Liquidity-heavy splits keep the provider share under MIN_PAYOUT, so no devnet USDC moves. */
const E2E_SPLITS = { providerBps: 1000, liquidityBps: 8000, platformBps: 1000 };
const REVENUE_PER_RUN_MICRO = 1_000_000n;
const SMALL_BUY_LAMPORTS = 20_000_000n;
type Wallet = 'treasury' | 'creator' | 'trader' | 'keeper';
/**
 * Measured on devnet (2026-10-02): the config costs the treasury about 0.01 SOL, the pool
 * costs the creator about 0.02, the trader pays 1 / 0.7 ≈ 1.43 SOL to put 1 SOL into the
 * curve at the 30% cliff fee, and the keeper's buy plus position rent stay under 0.05.
 * The faucet hands out 5 SOL a day, so the run asks for little more than it spends.
 */
const FUNDING: readonly { who: Wallet; sol: number }[] = [
  { who: 'treasury', sol: 0.1 },
  { who: 'creator', sol: 0.1 },
  { who: 'trader', sol: 1.7 },
  { who: 'keeper', sol: 0.1 },
];
/** The public faucet refused a single 5 SOL request. */
const AIRDROP_MAX_SOL = 2;
/** The daily limit does not clear within the retry window. */
const FAUCET_DRY = /airdrop limit|run dry|too many requests/i;

const results: { name: string; ok: boolean }[] = [];

function check(name: string, ok: boolean, detail = ''): boolean {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  return ok;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function airdrop(connection: Connection, to: PublicKey, sol: number): Promise<boolean> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const signature = await connection.requestAirdrop(to, Math.round(sol * LAMPORTS_PER_SOL));
      const latest = await connection.getLatestBlockhash('confirmed');
      const { value } = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
      if (!value.err) return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  airdrop attempt ${attempt} failed: ${message}`);
      if (FAUCET_DRY.test(message)) return false;
    }
    await sleep(2 ** attempt * 1000);
  }
  return false;
}

async function transferSol(
  connection: Connection,
  from: Keypair,
  to: readonly { pubkey: PublicKey; lamports: bigint }[],
): Promise<string> {
  const tx = new Transaction();
  for (const { pubkey, lamports } of to) {
    tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: pubkey, lamports }));
  }
  const { signature } = await sendAndConfirm({
    connection,
    tx,
    signers: [from],
    commitment: 'confirmed',
    simulate: true,
  });
  return signature;
}

/** The faucet confirms on its own RPC; RPC_URL may see the balance a few slots later. */
async function waitForLamports(connection: Connection, who: PublicKey, min: bigint) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (BigInt(await connection.getBalance(who, 'confirmed')) >= min) return true;
    await sleep(1500);
  }
  return false;
}

async function fund(connection: Connection, keys: Record<Wallet, Keypair>): Promise<boolean> {
  const lamportsOf = (sol: number) => BigInt(Math.round(sol * LAMPORTS_PER_SOL));
  const totalSol = FUNDING.reduce((sum, { sol }) => sum + sol, 0);
  if (process.env.DEVNET_FUNDER_SECRET_KEY?.trim()) {
    const funder = readSecretKeypair('DEVNET_FUNDER_SECRET_KEY');
    const balance = BigInt(await connection.getBalance(funder.publicKey, 'confirmed'));
    const enough = balance >= lamportsOf(totalSol) + 10_000n;
    const label = `funder ${funder.publicKey.toBase58()} holds ${totalSol} SOL`;
    if (!check(label, enough, `${lamportsToSol(balance)} SOL`)) return false;
    const signature = await transferSol(
      connection,
      funder,
      FUNDING.map(({ who, sol }) => ({ pubkey: keys[who].publicKey, lamports: lamportsOf(sol) })),
    );
    return check(`fund ${totalSol} SOL from DEVNET_FUNDER_SECRET_KEY`, true, signature);
  }
  const faucet = new Connection(
    process.env.AIRDROP_RPC_URL?.trim() || DEVNET_PUBLIC_RPC,
    'confirmed',
  );
  const treasury = keys.treasury.publicKey;
  for (let remaining = totalSol; remaining > 0; remaining -= AIRDROP_MAX_SOL) {
    if (!(await airdrop(faucet, treasury, Math.min(AIRDROP_MAX_SOL, remaining)))) {
      return check(
        `airdrop ${totalSol} SOL to the treasury`,
        false,
        'the faucet refused; fund a wallet at https://faucet.solana.com and pass it as DEVNET_FUNDER_SECRET_KEY',
      );
    }
  }
  const landed = await waitForLamports(connection, treasury, lamportsOf(totalSol));
  if (!check(`airdrop ${totalSol} SOL to the treasury`, landed)) return false;
  const others = FUNDING.filter(({ who }) => who !== 'treasury');
  const signature = await transferSol(
    connection,
    keys.treasury,
    others.map(({ who, sol }) => ({ pubkey: keys[who].publicKey, lamports: lamportsOf(sol) })),
  );
  return check(`treasury funds ${others.map(({ who }) => who).join(', ')}`, true, signature);
}

function hourStart(offsetHours: number): Date {
  return new Date((Math.floor(Date.now() / HOUR_MS) + offsetHours) * HOUR_MS);
}

interface SettleSummary {
  chain: string;
  settlements: { model: string; settlementId?: string; state?: string }[];
}

function settleOnce(env: NodeJS.ProcessEnv, periodStart: Date): Promise<SettleSummary | null> {
  // No `--` separator: settle-once would read everything after it as positionals.
  const args = ['pnpm', '--filter', '@ibt/keeper', 'settle:once', '--chain', 'real'];
  args.push('--period-start', periodStart.toISOString());
  return new Promise((resolve) => {
    const child = spawn('corepack', args, { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', (err) => {
      console.log(`  settle:once could not start: ${err.message}`);
      resolve(null);
    });
    child.on('close', (code) => {
      const line = stdout
        .trim()
        .split('\n')
        .reverse()
        .find((l) => l.startsWith('{'));
      if (code !== 0 || !line) {
        console.log(`  settle:once exited ${code}; stdout: ${stdout.slice(-500)}`);
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(line) as SettleSummary);
      } catch (_err) {
        console.log(`  settle:once printed no JSON summary: ${line.slice(0, 200)}`);
        resolve(null);
      }
    });
  });
}

async function seedRevenue(modelId: Types.ObjectId, userId: Types.ObjectId, at: Date) {
  await Requests.create({
    userId,
    apiKeyId: new Types.ObjectId(),
    modelId,
    requestId: `devnet-e2e-${new Types.ObjectId().toHexString()}`,
    status: 'success',
    promptTokens: 100,
    completionTokens: 100,
    costMicroUsdc: REVENUE_PER_RUN_MICRO,
    createdAt: at,
  });
}

function isolatedMongoUri(raw: string): { uri: string; dbName: string } {
  const url = new URL(raw);
  const dbName = `${E2E_DB_PREFIX}${Date.now()}`;
  url.pathname = `/${dbName}`;
  return { uri: url.toString(), dbName };
}

async function dropRunDatabase(dbName: string): Promise<void> {
  const db = mongoConnection.db;
  if (!dbName.startsWith(E2E_DB_PREFIX) || db?.databaseName !== dbName) return;
  try {
    // Model init (collection + index creation) may still be running; finish it first or it
    // recreates collections right after the drop.
    await Promise.all(ALL_MODELS.map((model) => model.init()));
    await db.dropDatabase();
    console.log(`dropped database ${dbName}`);
  } catch (err) {
    console.log(
      `warning: could not drop ${dbName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

runMain(async () => {
  if (process.env.DEVNET_E2E !== '1') {
    console.log('skipped (set DEVNET_E2E=1 to run the devnet end-to-end flow)');
    return EXIT_OK;
  }
  const cluster = process.env.CLUSTER?.trim() || 'devnet';
  if (cluster !== 'devnet') {
    throw new CliError(`refusing to run on ${cluster}: devnet-e2e is devnet-only`, EXIT_REFUSED);
  }
  if (!existsSync(KEEPER_ENV_FILE)) {
    throw new CliError(
      'apps/keeper/.env is missing; settle:once loads it (cp apps/keeper/.env.example apps/keeper/.env)',
    );
  }
  const rpcUrl = process.env.RPC_URL?.trim() || DEVNET_PUBLIC_RPC;
  const { uri: mongoUri, dbName } = isolatedMongoUri(
    process.env.MONGODB_URI?.trim() || DEFAULT_MONGODB_URI,
  );
  const usdcMint = USDC_MINT.devnet;

  const keys = {
    treasury: Keypair.generate(),
    creator: Keypair.generate(),
    trader: Keypair.generate(),
    keeper: Keypair.generate(),
  };
  const chain = new RealChainClient({ rpcUrl, usdcMint });
  const connection = chain.rpc.primary;
  // Before any funding: with a mainnet RPC, DEVNET_FUNDER_SECRET_KEY would move real SOL.
  await assertRpcCluster(connection, 'devnet');
  const send = (tx: Transaction, signer: Keypair, extra: Keypair[] = []) =>
    sendAndConfirm({
      connection,
      tx,
      signers: [signer],
      extraSigners: extra,
      commitment: 'confirmed',
      simulate: true,
    });
  console.log(
    `devnet-e2e on ${rpcUrl.replace(/\?.*$/, '')}, database ${new URL(mongoUri).pathname}`,
  );
  for (const [name, key] of Object.entries(keys)) {
    console.log(`  ${name.padEnd(8)} ${key.publicKey.toBase58()} (throwaway)`);
  }

  // 1. Funding
  if (!(await fund(connection, keys))) return EXIT_ERROR;

  // 2. Partner config with the devnet 1 SOL threshold
  const config = Keypair.generate();
  const threshold = BigInt(buildPartnerConfigParams('devnet').migrationQuoteThreshold.toString(10));
  const configTx = await buildCreateConfigTx({
    connection,
    configPubkey: config.publicKey,
    treasury: keys.treasury.publicKey,
    cluster: 'devnet',
  });
  await send(configTx, keys.treasury, [config]);
  const configAccount = await connection.getAccountInfo(config.publicKey, 'confirmed');
  check(
    'createConfig',
    configAccount?.owner.equals(DBC_PROGRAM_ID) === true,
    `${config.publicKey.toBase58()}, threshold ${lamportsToSol(threshold)} SOL`,
  );

  // 3. Launch (DBC createPool)
  const mint = Keypair.generate();
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const poolTx = await dbc.creator.createPool({
    name: 'IBT devnet e2e',
    symbol: 'IBTE2E',
    uri: 'https://example.com/ibt-devnet-e2e.json',
    payer: keys.creator.publicKey,
    poolCreator: keys.creator.publicKey,
    config: config.publicKey,
    baseMint: mint.publicKey,
  });
  const launch = await send(poolTx, keys.creator, [mint]);
  const launched = await chain.readPool({ mint: mint.publicKey, config: config.publicKey });
  const launchedOk = launched?.creator === keys.creator.publicKey.toBase58();
  check('createPool', launchedOk, launch.signature);
  if (!launched || !launchedOk) return EXIT_ERROR;
  const pool = new PublicKey(launched.address);

  // 4. Three buys on the curve
  for (let i = 1; i <= 3; i += 1) {
    const before = BigInt((await chain.readPool({ pool }))?.quoteReserve ?? '0');
    const buy = await chain.curveBuy(keys.trader, pool, SMALL_BUY_LAMPORTS, {
      slippageBps: SLIPPAGE_BPS,
    });
    const after = BigInt((await chain.readPool({ pool }))?.quoteReserve ?? '0');
    check(`curve buy ${i}`, after > before && buy.outAmount > 0n, buy.signature);
  }

  await connectDb(mongoUri);
  try {
    await syncAllIndexes();
    const provider = await Users.create({
      wallet: keys.creator.publicKey.toBase58(),
      depositRef: generateDepositRef(),
      role: 'provider',
    });
    const consumer = await Users.create({
      wallet: keys.trader.publicKey.toBase58(),
      depositRef: generateDepositRef(),
    });
    const model = await Models.create({
      providerId: provider._id,
      slug: 'devnet-e2e',
      name: 'devnet e2e',
      upstream: {
        baseUrl: 'http://localhost:4010/v1',
        modelName: 'mock-model',
        apiKeyEnc: 'unused-by-the-keeper',
      },
      pricing: { inputPerMTokMicroUsdc: 1_000_000n, outputPerMTokMicroUsdc: 2_000_000n },
      splits: E2E_SPLITS,
      token: {
        status: 'curve',
        symbol: 'IBTE2E',
        mint: mint.publicKey.toBase58(),
        dbcPool: pool.toBase58(),
        launchSignature: launch.signature,
      },
    });
    const keeperEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CLUSTER: 'devnet',
      CHAIN_MODE: 'real',
      RPC_URL: rpcUrl,
      USDC_MINT: usdcMint.toBase58(),
      TREASURY_SECRET_KEY: bs58.encode(keys.treasury.secretKey),
      KEEPER_SECRET_KEY: bs58.encode(keys.keeper.secretKey),
      MONGODB_URI: mongoUri,
      JUPITER_PRICE_URL: process.env.JUPITER_PRICE_URL?.trim() || DEFAULT_JUPITER_PRICE_URL,
    };

    // 5. Settlement while the token is on the curve
    const curvePeriod = hourStart(-3);
    await seedRevenue(model._id, consumer._id, new Date(curvePeriod.getTime() + 60_000));
    const first = await settleOnce(keeperEnv, curvePeriod);
    const firstId = first?.chain === 'real' ? first.settlements[0]?.settlementId : undefined;
    const curveSettlement = firstId ? await Settlements.findById(firstId).lean() : null;
    check(
      'settlement on the curve',
      curveSettlement?.state === 'done' && curveSettlement.liquidity.buyTxSignature != null,
      curveSettlement?.liquidity.buyTxSignature ?? 'no curve buy recorded',
    );

    // 6. Buy up to the migration threshold
    for (let i = 0; i < 5; i += 1) {
      const state = await chain.readPool({ pool });
      if (!state || BigInt(state.quoteReserve) >= threshold) break;
      const room = threshold - BigInt(state.quoteReserve);
      // PartialFill caps the buy at the room left; the margin covers the trading fee.
      await chain.curveBuy(keys.trader, pool, room + room / 10n + 1_000_000n, {
        slippageBps: SLIPPAGE_BPS,
      });
    }
    const full = await chain.readPool({ pool });
    check(
      'curve reaches the threshold',
      full !== null && BigInt(full.quoteReserve) >= threshold,
      `${full?.quoteReserve ?? '?'} / ${threshold} lamports`,
    );

    // 7. Migration to DAMM v2 (the keeper's migration crank, run here directly)
    const migration = await chain.migrate(keys.keeper, pool);
    const damm = await chain.readDammPool(mint.publicKey);
    if (!check('migrateToDammV2', damm !== null, migration.signature)) return EXIT_ERROR;
    await Models.updateOne(
      { _id: model._id },
      {
        $set: {
          'token.status': 'graduated',
          'token.dammV2Pool': deriveDammPool(mint.publicKey).toBase58(),
          'token.migrationSignature': migration.signature,
        },
      },
    );

    // 8. Settlement after graduation
    const dammPeriod = hourStart(-2);
    await seedRevenue(model._id, consumer._id, new Date(dammPeriod.getTime() + 60_000));
    const second = await settleOnce(keeperEnv, dammPeriod);
    const secondId = second?.chain === 'real' ? second.settlements[0]?.settlementId : undefined;
    const dammSettlement = secondId ? await Settlements.findById(secondId).lean() : null;
    check(
      'settlement after graduation',
      dammSettlement?.state === 'done' && dammSettlement.liquidity.lockTxSignature != null,
      dammSettlement?.liquidity.lockTxSignature ?? 'no lock recorded',
    );

    // 9. Keeper position permanently locked, fees claimable
    const graduated = await Models.findById(model._id).lean();
    const position = graduated?.token.keeperPosition;
    const nftAccount = graduated?.token.keeperPositionNftAccount;
    check('keeper position recorded', Boolean(position && nftAccount));
    if (!position || !nftAccount) return EXIT_ERROR;
    const positionKey = new PublicKey(position);
    const state = await new CpAmm(connection).fetchPositionState(positionKey);
    check(
      'position permanently locked',
      !state.permanentLockedLiquidity.isZero() && state.unlockedLiquidity.isZero(),
      `permanent ${state.permanentLockedLiquidity.toString()}, unlocked ${state.unlockedLiquidity.toString()}`,
    );
    const dammPool = await readDammPool(connection, deriveDammPool(mint.publicKey));
    if (dammPool) {
      const claimTx = await buildClaimPositionFee(connection, {
        owner: keys.keeper.publicKey,
        pool: dammPool,
        position: positionKey,
        positionNftAccount: new PublicKey(nftAccount),
      });
      claimTx.feePayer = keys.keeper.publicKey;
      claimTx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      const simulated = await connection.simulateTransaction(claimTx, [keys.keeper]);
      check('claimPositionFee simulates', simulated.value.err === null);
    } else {
      check('claimPositionFee simulates', false, 'DAMM v2 pool not readable');
    }
  } finally {
    await dropRunDatabase(dbName);
    await disconnectDb();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  return failed.length === 0 ? EXIT_OK : EXIT_ERROR;
});
