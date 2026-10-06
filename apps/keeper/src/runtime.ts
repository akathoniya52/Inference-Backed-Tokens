import {
  JUPITER_TIMEOUT_MS,
  JupiterPriceSource,
  type PriceSource,
  RealChainClient,
} from '@ibt/chain';
import {
  createFakeChain,
  type FakeChainMongo,
  type FakeChainTx,
  loadFakeSolUsd,
} from '@ibt/chain/testing';
import { connection } from '@ibt/db';
import { MIN_PAYOUT_MICRO, solToLamports, usdcStringToMicro } from '@ibt/shared';
import type { Alerter } from '@ibt/shared/node';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { Logger } from 'pino';

import { sleep, systemClock, type KeeperConfig, type KeeperCtx } from './ctx.js';
import type { KeeperEnv } from './env.js';
import { parseSecretKey } from './keys.js';

export type ChainMode = 'real' | 'fake';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const FAKE_FUNDING = 1_000_000_000_000_000n;
/** Used when `seed-models --fake-token` has not stored a price in `fakeChainPrices`. */
export const DEFAULT_FAKE_SOL_USD = 150;

/** Fake SOL price read from `fakeChainPrices` on every call, so a re-seeded price applies. */
export class SeededFakePriceSource implements PriceSource {
  constructor(
    private readonly mongo: FakeChainMongo,
    private readonly fallback = DEFAULT_FAKE_SOL_USD,
  ) {}

  async solUsd(): Promise<number> {
    return (await loadFakeSolUsd(this.mongo)) ?? this.fallback;
  }
}

export function mongoHosts(uri: string): string[] {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri);
  if (!match?.[1]) return [];
  return match[1].split(',').map((host) => host.replace(/:\d+$/, ''));
}

/** G24: the fake chain is refused on mainnet and against any non-local database. */
export function assertFakeChainAllowed(env: Pick<KeeperEnv, 'CLUSTER' | 'MONGODB_URI'>): void {
  if (env.CLUSTER === 'mainnet-beta') throw new Error('fake chain is refused on mainnet-beta');
  const hosts = mongoHosts(env.MONGODB_URI);
  if (hosts.length === 0 || !hosts.every((host) => LOCAL_HOSTS.has(host))) {
    throw new Error('fake chain requires MONGODB_URI on localhost or 127.0.0.1');
  }
}

export function keeperConfig(env: KeeperEnv): KeeperConfig {
  return {
    minPayoutMicroUsdc: MIN_PAYOUT_MICRO,
    maxPayoutMicroUsdc: usdcStringToMicro(env.MAX_PAYOUT_USDC_PER_RUN),
    maxSliceLamports: solToLamports(env.MAX_SLICE_SOL_PER_RUN),
    pendingTxPollMs: 2_000,
    pendingTxMaxPolls: 30,
  };
}

function signer(name: string, raw: string | undefined, mode: ChainMode): Keypair {
  if (raw) {
    try {
      return parseSecretKey(name, raw);
    } catch (err) {
      if (mode === 'real') throw err;
    }
  } else if (mode === 'real') {
    throw new Error(`${name} is required with the real chain`);
  }
  return Keypair.generate();
}

/** Builds the runtime context; call after `connectDb`. */
export function buildKeeperCtx(
  env: KeeperEnv,
  mode: ChainMode,
  deps: { logger: Logger; alerter: Alerter },
): KeeperCtx {
  const keeper = signer('KEEPER_SECRET_KEY', env.KEEPER_SECRET_KEY, mode);
  const treasury = signer('TREASURY_SECRET_KEY', env.TREASURY_SECRET_KEY, mode);
  const base = { ...deps, keeper, treasury, clock: systemClock, config: keeperConfig(env), sleep };

  if (mode === 'fake') {
    assertFakeChainAllowed(env);
    const db = connection.db;
    if (!db) throw new Error('connectDb must run before buildKeeperCtx');
    const mongo: FakeChainMongo = { collection: (name) => db.collection<FakeChainTx>(name) };
    const price = new SeededFakePriceSource(mongo);
    const chain = createFakeChain({
      priceSource: price,
      usdcMint: new PublicKey(env.USDC_MINT),
      mongo,
    });
    chain.setUsdc(treasury.publicKey, FAKE_FUNDING);
    chain.setSol(keeper.publicKey, FAKE_FUNDING);
    return { ...base, chain, price, blockHeight: () => Promise.resolve(Number.MAX_SAFE_INTEGER) };
  }

  const chain = new RealChainClient({
    rpcUrl: env.RPC_URL,
    ...(env.RPC_URL_FALLBACK ? { fallbackUrl: env.RPC_URL_FALLBACK } : {}),
    usdcMint: new PublicKey(env.USDC_MINT),
  });
  // A quote must be recent against the cluster's slot, and a hung request times out (CHN-06).
  const price = new JupiterPriceSource({
    url: env.JUPITER_PRICE_URL,
    ...(env.JUPITER_API_KEY ? { apiKey: env.JUPITER_API_KEY } : {}),
    timeoutMs: JUPITER_TIMEOUT_MS,
    currentSlot: () => chain.rpc.withRetry((conn) => conn.getSlot('confirmed')),
  });
  return { ...base, chain, price, blockHeight: () => chain.rpc.read.getBlockHeight() };
}
