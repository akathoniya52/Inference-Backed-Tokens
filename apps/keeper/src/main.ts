import './version-check.js';

import { hostname } from 'node:os';

import { connectDb, disconnectDb } from '@ibt/db';
import { createLogAlerter, createLogger } from '@ibt/shared/node';

import { loadEnv } from './env.js';
import { createHealthServer } from './health-server.js';
import { POOL_POLLER_CRON, createPoolPoller } from './jobs/poolPoller.js';
import { createLease } from './lease.js';
import { buildKeeperCtx } from './runtime.js';
import { createScheduler } from './scheduler.js';
import { createOrchestrator } from './settlement/orchestrator.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, name: 'keeper' });
  await connectDb(env.MONGODB_URI);
  const ctx = buildKeeperCtx(env, env.CHAIN_MODE, { logger, alerter: createLogAlerter(logger) });
  logger.info(
    { cluster: env.CLUSTER, chain: env.CHAIN_MODE, keeper: ctx.keeper.publicKey.toBase58() },
    'keeper starting',
  );

  const scheduler = createScheduler({ logger });
  const poolPoller = createPoolPoller(ctx);
  scheduler.add('poolPoller', POOL_POLLER_CRON, () => poolPoller.tick());
  const orchestrator = createOrchestrator(ctx);
  scheduler.add('settle', env.SETTLEMENT_CRON, async () => {
    await orchestrator.run();
  });
  const lease = createLease({
    holder: `${hostname()}:${process.pid}`,
    clock: ctx.clock,
    logger,
    onAcquired: () => {
      scheduler.start();
      // Boot resume (L172): the run's resume scan finishes settlements a crashed holder
      // left open. Not awaited, so a long run never delays the lease renewal.
      void scheduler.runNow('settle');
    },
    onLost: () => scheduler.stop(),
  });

  const server = createHealthServer().listen(env.KEEPER_PORT, () => {
    logger.info({ port: env.KEEPER_PORT }, 'keeper health server listening');
  });
  await lease.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'keeper shutting down');
    scheduler.stop();
    await lease.stop();
    server.close();
    await disconnectDb();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal));
  }
}

main().catch((err: unknown) => {
  createLogger({ level: 'error', name: 'keeper' }).fatal({ err }, 'keeper failed to start');
  process.exit(1);
});
