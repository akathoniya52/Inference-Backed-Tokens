// Seeds the local model set (work plan P8-T2, §9). Upstream defaults to the mock on :4010.
// `--dev-credit` and `--fake-token` are local-only (G23): refused on mainnet-beta and against
// any MONGODB_URI that is not on localhost/127.0.0.1.
import { parseArgs } from 'node:util';

import { createFakeChain, type FakeChainTx, saveFakeSolUsd } from '@ibt/chain/testing';
import {
  adjust,
  connection,
  connectDb,
  disconnectDb,
  Models,
  syncAllIndexes,
  type Types,
  Users,
} from '@ibt/db';
import { microToUsdcString, PublicKeySchema, usdcStringToMicro } from '@ibt/shared';
import { encrypt, generateDepositRef } from '@ibt/shared/node';
import { DEFAULT_MOCK_API_KEY } from '@ibt/mock-upstream';
import { Keypair, PublicKey } from '@solana/web3.js';

import { CliError, EXIT_OK, EXIT_REFUSED, runMain } from './lib/cli.js';

const USAGE =
  'usage: seed-models.ts [--owner <wallet>] [--dev-credit <wallet> <usdc>] [--fake-token]\n' +
  '  env: MONGODB_URI, MASTER_KEY (required); MOCK_UPSTREAM_PORT, CLUSTER, DBC_CONFIG (optional)';
const LOCAL_MONGO_HOSTS = new Set(['localhost', '127.0.0.1']);
const DEV_CREDIT_REASON = 'dev_credit';
/** Seeded for the fake price source; any positive price makes the settlement slice > 0 lamports. */
const FAKE_SOL_USD = 150;
const FAKE_TOKEN_SYMBOL = 'MOCK';

interface SeedModel {
  slug: string;
  name: string;
  description: string;
  upstreamModel: string;
  inputPerMTokMicroUsdc: bigint;
  outputPerMTokMicroUsdc: bigint;
}

const SEED_MODELS: readonly SeedModel[] = [
  {
    slug: 'mock-llm',
    name: 'Mock LLM',
    description: 'Local mock upstream (apps/mock-upstream) for development and smoke tests.',
    upstreamModel: 'mock-model',
    inputPerMTokMicroUsdc: 1_000_000n,
    outputPerMTokMicroUsdc: 2_000_000n,
  },
];
const FAKE_TOKEN_SLUG = 'mock-llm';

interface Flags {
  owner: string | undefined;
  devCredit: { wallet: string; usdc: string } | null;
  fakeToken: boolean;
}

function parseFlags(): Flags {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        owner: { type: 'string' },
        'dev-credit': { type: 'string' },
        'fake-token': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    throw new CliError(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const wallet = values['dev-credit'];
  const expected = wallet === undefined ? 0 : 1;
  if (positionals.length !== expected) {
    throw new CliError(`--dev-credit takes <wallet> <usdc>; nothing else is positional\n${USAGE}`);
  }
  const usdc = positionals[0];
  return {
    owner: values.owner,
    devCredit: wallet !== undefined && usdc !== undefined ? { wallet, usdc } : null,
    fakeToken: values['fake-token'] ?? false,
  };
}

function mongoHost(uri: string): string | null {
  try {
    return new URL(uri).hostname;
  } catch (_err) {
    // Multi-host seed lists are not valid URLs; they are never local.
    return null;
  }
}

/** G23: runs before any connection or write. */
function assertLocalOnly(flag: string, uri: string): void {
  if (process.env.CLUSTER?.trim() === 'mainnet-beta') {
    throw new CliError(
      `refusing ${flag}: CLUSTER is mainnet-beta; nothing was written`,
      EXIT_REFUSED,
    );
  }
  const host = mongoHost(uri);
  if (host === null || !LOCAL_MONGO_HOSTS.has(host)) {
    throw new CliError(
      `refusing ${flag}: MONGODB_URI host ${host ?? '<unparseable>'} is not localhost or 127.0.0.1; ` +
        'nothing was written',
      EXIT_REFUSED,
    );
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new CliError(`${name} is not set (load it with tsx --env-file=apps/api/.env)`);
  return value;
}

function parseWallet(name: string, value: string): string {
  if (!PublicKeySchema.safeParse(value).success) {
    throw new CliError(`${name} is not a base58 public key`);
  }
  return value;
}

function parseUsdc(value: string): bigint {
  let micro: bigint;
  try {
    micro = usdcStringToMicro(value);
  } catch (_err) {
    throw new CliError('--dev-credit <usdc> must be a USDC amount such as 10 or 2.5');
  }
  if (micro <= 0n) throw new CliError('--dev-credit <usdc> must be greater than 0');
  return micro;
}

function optionalPublicKey(name: string): PublicKey | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch (_err) {
    return null;
  }
}

/** Same user shape the api's sign-in creates (`apps/api/src/modules/auth/service.ts`). */
async function upsertUser(wallet: string): Promise<Types.ObjectId> {
  const user = await Users.findOneAndUpdate(
    { wallet },
    { $setOnInsert: { wallet, depositRef: generateDepositRef(), role: 'consumer' } },
    { upsert: true, new: true },
  ).lean();
  return user._id;
}

function upstreamBaseUrl(): string {
  const port = process.env.MOCK_UPSTREAM_PORT?.trim() || '4010';
  return `http://localhost:${port}/v1`;
}

async function seedModels(ownerId: Types.ObjectId, masterKey: string) {
  const baseUrl = upstreamBaseUrl();
  const seeded = [];
  for (const seed of SEED_MODELS) {
    const existed = (await Models.exists({ slug: seed.slug })) !== null;
    const doc = await Models.findOneAndUpdate(
      { slug: seed.slug },
      {
        $set: {
          name: seed.name,
          description: seed.description,
          upstream: {
            baseUrl,
            modelName: seed.upstreamModel,
            apiKeyEnc: encrypt(DEFAULT_MOCK_API_KEY, masterKey),
            supportsStreamUsage: false,
          },
          pricing: {
            inputPerMTokMicroUsdc: seed.inputPerMTokMicroUsdc,
            outputPerMTokMicroUsdc: seed.outputPerMTokMicroUsdc,
          },
        },
        $setOnInsert: { slug: seed.slug, providerId: ownerId, status: 'active' },
      },
      { upsert: true, new: true },
    ).lean();
    seeded.push({
      slug: seed.slug,
      id: doc._id.toHexString(),
      created: !existed,
      upstream: baseUrl,
    });
  }
  return seeded;
}

async function seedFakeToken(owner: string) {
  const db = connection.db;
  if (!db) throw new Error('connectDb must run first');
  const model = await Models.findOne({ slug: FAKE_TOKEN_SLUG }).lean();
  if (!model) throw new Error(`model ${FAKE_TOKEN_SLUG} was not seeded`);

  const mint = model.token.mint ? new PublicKey(model.token.mint) : Keypair.generate().publicKey;
  // A real DBC_CONFIG keeps the fake pool consistent with launch verification; any key works.
  const config = optionalPublicKey('DBC_CONFIG') ?? PublicKey.default;
  const mongo = { collection: (name: string) => db.collection<FakeChainTx>(name) };
  const chain = createFakeChain({ mongo });
  const dbcPool = await chain.addPersistedPool({ mint, config, creator: new PublicKey(owner) });
  await saveFakeSolUsd(mongo, FAKE_SOL_USD);

  await Models.updateOne(
    { _id: model._id },
    {
      $set: {
        'token.status': 'curve',
        'token.symbol': model.token.symbol ?? FAKE_TOKEN_SYMBOL,
        'token.mint': mint.toBase58(),
        'token.dbcPool': dbcPool.toBase58(),
      },
    },
  );
  return {
    slug: FAKE_TOKEN_SLUG,
    mint: mint.toBase58(),
    dbcPool: dbcPool.toBase58(),
    config: config.toBase58(),
    solUsd: FAKE_SOL_USD,
  };
}

async function devCredit(wallet: string, micro: bigint) {
  const userId = await upsertUser(wallet);
  const { balanceMicro } = await adjust(userId, micro, DEV_CREDIT_REASON);
  return {
    wallet,
    userId: userId.toHexString(),
    creditedUsdc: microToUsdcString(micro),
    balanceUsdc: microToUsdcString(balanceMicro),
  };
}

runMain(async () => {
  const flags = parseFlags();
  const uri = requireEnv('MONGODB_URI');
  if (flags.devCredit) assertLocalOnly('--dev-credit', uri);
  if (flags.fakeToken) assertLocalOnly('--fake-token', uri);

  const masterKey = requireEnv('MASTER_KEY');
  const credit = flags.devCredit && {
    wallet: parseWallet('--dev-credit <wallet>', flags.devCredit.wallet),
    micro: parseUsdc(flags.devCredit.usdc),
  };
  const owner =
    flags.owner !== undefined
      ? parseWallet('--owner', flags.owner)
      : (optionalPublicKey('TREASURY_WALLET') ?? Keypair.generate().publicKey).toBase58();

  await connectDb(uri);
  try {
    await syncAllIndexes();
    const ownerId = await upsertUser(owner);
    const models = await seedModels(ownerId, masterKey);
    const fakeToken = flags.fakeToken ? await seedFakeToken(owner) : null;
    const credited = credit ? await devCredit(credit.wallet, credit.micro) : null;
    console.log(JSON.stringify({ owner, models, fakeToken, devCredit: credited }, null, 2));
    return EXIT_OK;
  } finally {
    await disconnectDb();
  }
});
