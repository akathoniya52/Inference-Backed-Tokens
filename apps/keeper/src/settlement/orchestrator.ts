import { Models, Settlements, type SettlementDoc, type Types } from '@ibt/db';

import type { KeeperCtx } from '../ctx.js';
import { runSettlement, type EngineOptions } from './engine.js';
import { assertLeaseHeld } from './fence.js';
import { settlementPeriod, type SettlementPeriod } from './period.js';
import { lease } from './steps.js';

/** Models settled in parallel (L249). */
export const SETTLEMENT_CONCURRENCY = 3;

export type SettlementOutcome =
  | { model: string; settlement: SettlementDoc; resumed: boolean }
  | { model: string; skipped: 'already_leased' };

export interface Orchestrator {
  /** Drives every settlement that is neither `done` nor `failed`, oldest period first. */
  resume(): Promise<SettlementOutcome[]>;
  /** Resume scan, then opens and runs `period` (default: the last complete hour) per model. */
  run(period?: SettlementPeriod): Promise<SettlementOutcome[]>;
}

export interface OrchestratorOptions extends EngineOptions {
  concurrency?: number;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight; results keep input order. After a
 * failure no new item starts, and the first error is thrown once every running one ended.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const failures: unknown[] = [];
  const worker = async () => {
    while (failures.length === 0 && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index] as T);
      } catch (err) {
        failures.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failures.length > 0) throw failures[0];
  return results;
}

export function createOrchestrator(ctx: KeeperCtx, opts: OrchestratorOptions = {}): Orchestrator {
  const { concurrency = SETTLEMENT_CONCURRENCY, ...engine } = opts;
  const log = ctx.logger.child({ job: 'settle' });

  async function slugs(ids: Types.ObjectId[]): Promise<Map<string, string>> {
    const rows = await Models.find({ _id: { $in: ids } }, { slug: 1 }).lean();
    return new Map(rows.map((row) => [row._id.toHexString(), row.slug]));
  }

  /** One run's view of `ctx`: provider payouts share `MAX_PAYOUT_USDC_PER_RUN` (G18). */
  const runCtx = (): KeeperCtx => ({
    ...ctx,
    payoutBudget: { remainingMicroUsdc: ctx.config.maxPayoutMicroUsdc },
  });

  async function resumeIn(ctx: KeeperCtx): Promise<SettlementOutcome[]> {
    const open = await Settlements.find({ state: { $nin: ['done', 'failed'] } }).sort({
      periodStart: 1,
    });
    if (open.length === 0) return [];
    const byModel = new Map<string, SettlementDoc[]>();
    for (const doc of open) {
      const key = doc.modelId.toHexString();
      byModel.set(key, [...(byModel.get(key) ?? []), doc]);
    }
    const names = await slugs(open.map((doc) => doc.modelId));
    log.info({ count: open.length }, 'resuming unfinished settlements');
    // One model's periods run in order: each consumes the carry-overs the previous left.
    const perModel = await mapLimit([...byModel], concurrency, async ([modelId, docs]) => {
      const outcomes: SettlementOutcome[] = [];
      for (const doc of docs) {
        const settlement = await runSettlement(ctx, doc, engine);
        outcomes.push({ model: names.get(modelId) ?? modelId, settlement, resumed: true });
      }
      return outcomes;
    });
    return perModel.flat();
  }

  async function run(period = settlementPeriod(ctx.clock.now())): Promise<SettlementOutcome[]> {
    const ctx = runCtx();
    const resumed = await resumeIn(ctx);
    const models = await Models.find({ status: { $ne: 'delisted' } }, { slug: 1 })
      .sort({ _id: 1 })
      .lean();
    const opened = await mapLimit(
      models,
      concurrency,
      async (model): Promise<SettlementOutcome> => {
        assertLeaseHeld(ctx);
        const doc = await lease(ctx, { modelId: model._id, ...period });
        if (!doc) return { model: model.slug, skipped: 'already_leased' };
        return {
          model: model.slug,
          settlement: await runSettlement(ctx, doc, engine),
          resumed: false,
        };
      },
    );
    const failed = opened.filter((o) => 'settlement' in o && o.settlement.state === 'failed');
    log.info(
      {
        periodStart: period.periodStart.toISOString(),
        resumed: resumed.length,
        opened: opened.length,
        failed: failed.length,
      },
      'settlement run finished',
    );
    return [...resumed, ...opened];
  }

  return { resume: () => resumeIn(runCtx()), run };
}
