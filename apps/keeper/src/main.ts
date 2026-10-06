import './version-check.js';

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { connectDb, disconnectDb } from '@ibt/db';
import { solToLamports } from '@ibt/shared';
import { createAlerter, createLogger, startSelfPing } from '@ibt/shared/node';

import { loadEnv } from './env.js';
import { startHealthServer } from './health-server.js';
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

/** How long shutdown waits for running jobs (a settlement step) before releasing the lease. */
const SHUTDOWN_DRAIN_MS = 25_000;

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
  const lease = createLease({
    // Unique per process (KPR-17): containers often share pid 1 and a static hostname.
    holder: `${hostname()}:${process.pid}:${randomUUID()}`,
    logger,
    onAcquired: () => {
      scheduler.start();
      // Boot resume (L172): the run's resume scan finishes settlements a crashed holder
      // left open. Not awaited, so a long run never delays the lease renewal.
      void scheduler.runNow('settle');
    },
    // A run in flight stops at its next send: settlement steps check `ctx.lease` first.
    onLost: () => scheduler.stop(),
  });
  const orchestrator = createOrchestrator({ ...ctx, lease });
  scheduler.add('settle', env.SETTLEMENT_CRON, async () => {
    await orchestrator.run();
  });

  let stopping = false;
  /**
   * Stops triggers, lets running jobs finish (at most `SHUTDOWN_DRAIN_MS`) before the
   * lease is released and the DB closed (KPR-14), and never rejects: any failure is
   * logged and the process exits non-zero.
   */
  const shutdown = async (reason: string, code = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
    let exitCode = code;
    try {
      logger.info({ reason }, 'keeper shutting down');
      selfPing.stop();
      scheduler.stop();
      if (!(await scheduler.drain(SHUTDOWN_DRAIN_MS))) {
        logger.warn({ ms: SHUTDOWN_DRAIN_MS }, 'jobs still running at shutdown; stopping anyway');
      }
      await lease.stop();
      server.close();
      await disconnectDb();
    } catch (err) {
      logger.error({ err }, 'keeper shutdown failed');
      exitCode = 1;
    }
    process.exit(exitCode);
  };

  const server = startHealthServer(env.KEEPER_PORT, {
    logger,
    onError: () => void shutdown('health server error', 1),
  });
  const selfPing = startSelfPing({
    baseUrl: env.SELF_PING_URL ?? env.RENDER_EXTERNAL_URL,
    logger,
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal));
  }
  await lease.start();
}

main().catch((err: unknown) => {
  createLogger({ level: 'error', name: 'keeper' }).fatal({ err }, 'keeper failed to start');
  process.exit(1);
});
