import { hostname } from 'node:os';
import { parseArgs } from 'node:util';

import { connectDb, disconnectDb } from '@ibt/db';
import { createLogAlerter, createLogger } from '@ibt/shared/node';

import { loadEnv } from '../env.js';
import { createLease } from '../lease.js';
import { buildKeeperCtx, type ChainMode } from '../runtime.js';
import { createOrchestrator } from '../settlement/orchestrator.js';
import { periodFromStart, settlementPeriod, type SettlementPeriod } from '../settlement/period.js';
import { outcomeSummary } from '../settlement/summary.js';

function parseCli(argv: string[]): { chain: ChainMode; period: SettlementPeriod } {
  const { values } = parseArgs({
    args: argv,
    options: { chain: { type: 'string', default: 'fake' }, 'period-start': { type: 'string' } },
    allowPositionals: true,
  });
  if (values.chain !== 'fake' && values.chain !== 'real') {
    throw new Error('--chain must be fake or real');
  }
  const raw = values['period-start'];
  const period = raw ? periodFromStart(new Date(raw)) : settlementPeriod(new Date());
  return { chain: values.chain, period };
}

async function main(): Promise<void> {
  const { chain, period } = parseCli(process.argv.slice(2));
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, name: 'settle-once' });
  await connectDb(env.MONGODB_URI);
  try {
    const ctx = buildKeeperCtx(env, chain, { logger, alerter: createLogAlerter(logger) });
    // Holding the keeper lease keeps a running keeper from driving the same settlements.
    const lease = createLease({
      holder: `settle-once:${hostname()}:${process.pid}`,
      clock: ctx.clock,
      logger,
    });
    if (!(await lease.tick())) throw new Error('keeper lease is held by another instance');
    try {
      const outcomes = await createOrchestrator(ctx).run(period);
      const summary = {
        chain,
        periodStart: period.periodStart.toISOString(),
        periodEnd: period.periodEnd.toISOString(),
        settlements: outcomes.map(outcomeSummary),
      };
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } finally {
      await lease.stop();
    }
  } finally {
    await disconnectDb();
  }
}

main().catch((err: unknown) => {
  createLogger({ level: 'error', name: 'settle-once' }).fatal({ err }, 'settle-once failed');
  process.exit(1);
});
