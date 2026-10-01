import { hostname } from 'node:os';
import { parseArgs } from 'node:util';

import { connectDb, disconnectDb } from '@ibt/db';
import { createLogAlerter, createLogger } from '@ibt/shared/node';

import { sleep } from '../ctx.js';
import { loadEnv } from '../env.js';
import { createLease } from '../lease.js';
import { buildKeeperCtx, type ChainMode } from '../runtime.js';
import { createOrchestrator } from '../settlement/orchestrator.js';
import { periodFromStart, settlementPeriod, type SettlementPeriod } from '../settlement/period.js';
import { SETTLEMENT_STEPS, type NamedStep } from '../settlement/steps.js';
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

// Test-only (test/acceptance.test.ts): SETTLE_ONCE_PAUSE_AFTER_STEP=<step name> sleeps
// SETTLE_ONCE_PAUSE_MS (default 60 s) after that step so a test can SIGKILL mid-run. No-op when unset.
function stepsWithPause(): { steps?: readonly NamedStep[] } {
  const after = process.env.SETTLE_ONCE_PAUSE_AFTER_STEP;
  if (!after) return {};
  const ms = Number(process.env.SETTLE_ONCE_PAUSE_MS ?? 60_000);
  return {
    steps: SETTLEMENT_STEPS.map((step) =>
      step.name === after
        ? {
            name: step.name,
            run: async (ctx, settlement) => {
              await step.run(ctx, settlement);
              await sleep(ms);
            },
          }
        : step,
    ),
  };
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
      const outcomes = await createOrchestrator(ctx, stepsWithPause()).run(period);
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
