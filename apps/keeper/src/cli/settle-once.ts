import { parseArgs } from 'node:util';

import { Models, connectDb, disconnectDb } from '@ibt/db';
import { createLogAlerter, createLogger } from '@ibt/shared/node';

import { loadEnv } from '../env.js';
import { buildKeeperCtx, type ChainMode } from '../runtime.js';

const HOUR_MS = 3_600_000;

function parseCli(argv: string[]): { chain: ChainMode; periodStart: Date } {
  const { values } = parseArgs({
    args: argv,
    options: { chain: { type: 'string', default: 'fake' }, 'period-start': { type: 'string' } },
    allowPositionals: true,
  });
  if (values.chain !== 'fake' && values.chain !== 'real') {
    throw new Error('--chain must be fake or real');
  }
  const raw = values['period-start'];
  const periodStart = raw
    ? new Date(raw)
    : new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS);
  if (Number.isNaN(periodStart.getTime()) || periodStart.getTime() % HOUR_MS !== 0) {
    throw new Error('--period-start must be an ISO timestamp on a UTC hour boundary');
  }
  return { chain: values.chain, periodStart };
}

async function main(): Promise<void> {
  const { chain, periodStart } = parseCli(process.argv.slice(2));
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, name: 'settle-once' });
  await connectDb(env.MONGODB_URI);
  try {
    buildKeeperCtx(env, chain, { logger, alerter: createLogAlerter(logger) });
    const models = await Models.find({ status: { $ne: 'delisted' } }, { slug: 1 }).lean();
    const summary = {
      chain,
      periodStart: periodStart.toISOString(),
      periodEnd: new Date(periodStart.getTime() + HOUR_MS).toISOString(),
      models: models.map((m) => m.slug),
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await disconnectDb();
  }
}

main().catch((err: unknown) => {
  createLogger({ level: 'error', name: 'settle-once' }).fatal({ err }, 'settle-once failed');
  process.exit(1);
});
