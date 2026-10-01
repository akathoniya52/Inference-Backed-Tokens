import { parseArgs } from 'node:util';

import { Models, connectDb, disconnectDb } from '@ibt/db';
import { createLogAlerter, createLogger } from '@ibt/shared/node';

import { loadEnv } from '../env.js';
import { buildKeeperCtx, type ChainMode } from '../runtime.js';
import { periodFromStart, settlementPeriod, type SettlementPeriod } from '../settlement/period.js';
import { SETTLEMENT_STEPS, lease, runSteps } from '../settlement/steps.js';

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
    const models = await Models.find({ status: { $ne: 'delisted' } }, { slug: 1 }).lean();
    const results = [];
    for (const model of models) {
      const settlement = await lease(ctx, { modelId: model._id, ...period });
      if (!settlement) {
        results.push({ model: model.slug, skipped: 'already_leased' });
        continue;
      }
      await runSteps(ctx, settlement, SETTLEMENT_STEPS);
      results.push({
        model: model.slug,
        settlementId: settlement._id.toHexString(),
        state: settlement.state,
        revenueMicroUsdc: settlement.revenueMicroUsdc.toString(),
        providerMicroUsdc: settlement.provider.amountMicroUsdc.toString(),
        providerTx: settlement.provider.txSignature ?? null,
      });
    }
    const summary = {
      chain,
      periodStart: period.periodStart.toISOString(),
      periodEnd: period.periodEnd.toISOString(),
      settlements: results,
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
