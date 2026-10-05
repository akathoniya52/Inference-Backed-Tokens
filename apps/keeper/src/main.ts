import './version-check.js';

import { hostname } from 'node:os';

import { connectDb, disconnectDb } from '@ibt/db';
import { solToLamports } from '@ibt/shared';
import { createAlerter, createLogger, startSelfPing } from '@ibt/shared/node';

import { loadEnv } from './env.js';
import { createHealthServer } from './health-server.js';
import { FLOAT_MONITOR_CRON, createFloatMonitor } from './jobs/floatMonitor.js';
import { HEALTH_CHECK_CRON, createHealthCheckJob } from './jobs/healthCheck.js';
import { HOLD_EXPIRY_CRON, createHoldExpiryJob } from './jobs/holdExpiry.js';
import { POOL_POLLER_CRON, createPoolPoller } from './jobs/poolPoller.js';
import { createReconcileJob } from './jobs/reconcile.js';
import { STATS_CRON, createStatsJob } from './jobs/stats.js';
import { createLease } from './lease.js';
import { buildKeeperCtx } from './runtime.js';
import { createScheduler } from './scheduler.js';
import { createOrchestrator } from './settlement/orchestrator.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, name: 'keeper' });
  await connectDb(env.MONGODB_URI);
  const ctx = buildKeeperCtx(env, env.CHAIN_MODE, {
    logger,
    alerter: createAlerter({
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
      logger,
    }),
  });
  logger.info(
    { cluster: env.CLUSTER, chain: env.CHAIN_MODE, keeper: ctx.keeper.publicKey.toBase58() },
    'keeper starting',
  );

  const scheduler = createScheduler({ logger });
  const poolPoller = createPoolPoller(ctx);
  scheduler.add('poolPoller', POOL_POLLER_CRON, () => poolPoller.tick());
  const floatMonitor = createFloatMonitor(ctx, {
    floatMinLamports: solToLamports(env.FLOAT_MIN_SOL),
  });
  scheduler.add('floatMonitor', FLOAT_MONITOR_CRON, async () => {
    await floatMonitor.tick();
  });
  const holdExpiry = createHoldExpiryJob(ctx);
  scheduler.add('holdExpiry', HOLD_EXPIRY_CRON, async () => {
    await holdExpiry.tick();
  });
  const stats = createStatsJob(ctx);
  scheduler.add('stats', STATS_CRON, async () => {
    await stats.tick();
  });
  if (env.ADMIN_TOKEN) {
    const healthCheck = createHealthCheckJob(ctx, {
      apiUrl: env.API_INTERNAL_URL,
      adminToken: env.ADMIN_TOKEN,
    });
    scheduler.add('healthCheck', HEALTH_CHECK_CRON, async () => {
      await healthCheck.tick();
    });
  } else {
    logger.warn('ADMIN_TOKEN is not set; healthCheck job disabled');
  }
  const reconcile = createReconcileJob(ctx);
  scheduler.add('reconcile', env.RECONCILE_CRON, async () => {
    await reconcile.tick();
  });
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
  const selfPing = startSelfPing({
    baseUrl: env.SELF_PING_URL ?? env.RENDER_EXTERNAL_URL,
    logger,
  });
  await lease.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'keeper shutting down');
    selfPing.stop();
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
