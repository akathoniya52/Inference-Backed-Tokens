import './version-check.js';

import type { ChainClient } from '@ibt/chain';
import { RealChainClient, USDC_MINT } from '@ibt/chain';
import { createFakeChain, type FakeChainTx } from '@ibt/chain/testing';
import { connectDb, connection, disconnectDb, syncAllIndexes } from '@ibt/db';
import { createLogAlerter, createLogger } from '@ibt/shared/node';

import { createApp } from './app.js';
import { loadEnv, type ApiEnv } from './env.js';

const SHUTDOWN_GRACE_MS = 10_000;

function buildChain(env: ApiEnv): ChainClient {
  const usdcMint = USDC_MINT[env.CLUSTER];
  if (env.CHAIN_MODE === 'fake') {
    const db = connection.db;
    if (!db) throw new Error('connectDb must run before buildChain');
    // Shares `fakeChainPools`/`fakeChainTxs` with seed-models and the keeper on the same Mongo.
    return createFakeChain({
      usdcMint,
      mongo: { collection: (name) => db.collection<FakeChainTx>(name) },
    });
  }
  return new RealChainClient({
    rpcUrl: env.RPC_URL,
    ...(env.RPC_URL_FALLBACK ? { fallbackUrl: env.RPC_URL_FALLBACK } : {}),
    usdcMint,
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, name: 'api' });
  if (USDC_MINT[env.CLUSTER].toBase58() !== env.USDC_MINT) {
    logger.warn(
      { cluster: env.CLUSTER },
      'USDC_MINT differs from the cluster default; using the default',
    );
  }

  await connectDb(env.MONGODB_URI);
  await syncAllIndexes();

  const app = createApp({
    env,
    chain: buildChain(env),
    alerter: createLogAlerter(logger),
    logger,
  });
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, chainMode: env.CHAIN_MODE }, 'api listening');
  });

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    setTimeout(() => {
      logger.error('shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    server.close((err) => {
      if (err) logger.error({ err }, 'server close failed');
      disconnectDb().then(
        () => process.exit(err ? 1 : 0),
        (dbErr: unknown) => {
          logger.error({ err: dbErr }, 'mongo disconnect failed');
          process.exit(1);
        },
      );
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  const logger = createLogger({ level: 'error', name: 'api' });
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
