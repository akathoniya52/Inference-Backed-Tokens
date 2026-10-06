import { Models, Requests, Settlements, type SettlementDoc, type Types } from '@ibt/db';

import type { KeeperCtx } from '../ctx.js';
import { runSettlement, type EngineOptions } from './engine.js';
import { LeaseLostError, assertLeaseHeld } from './fence.js';
import { PERIOD_MS, settlementPeriod, type SettlementPeriod } from './period.js';
import { lease } from './steps.js';

/** Models settled in parallel (L249). */
export const SETTLEMENT_CONCURRENCY = 3;
/** Most periods one run opens per model when backfilling missed hours (KPR-08). */
export const MAX_PERIODS_PER_RUN = 48;

export type SettlementOutcome =
  | { model: string; settlement: SettlementDoc; resumed: boolean }
  | { model: string; skipped: 'already_leased' }
  | { model: string; error: string };

/**
 * Periods to open for a model whose latest settlement starts at `lastStart` (KPR-08): every
 * hour after it up to `target`, oldest first and at most `MAX_PERIODS_PER_RUN` (the rest
 * follow in later runs). A model with no settlement, or one already past `target`, gets
 * `target` alone.
 */
export function periodsToOpen(
  lastStart: Date | null,
  target: SettlementPeriod,
): SettlementPeriod[] {
  const end = target.periodStart.getTime();
  if (!lastStart || lastStart.getTime() >= end) return [target];
  const periods: SettlementPeriod[] = [];
  for (
    let start = lastStart.getTime() + PERIOD_MS;
    start <= end && periods.length < MAX_PERIODS_PER_RUN;
    start += PERIOD_MS
  ) {
    periods.push({ periodStart: new Date(start), periodEnd: new Date(start + PERIOD_MS) });
  }
  return periods;
}

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
    payoutBudget: { remainingMicroUsdc: ctx.config.maxPayoutMicroUsdc, charged: new Set() },
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
      const name = names.get(modelId) ?? modelId;
      return perModelSafely(name, async (outcomes) => {
        for (const doc of docs) {
          const settlement = await runSettlement(ctx, doc, engine);
          outcomes.push({ model: name, settlement, resumed: true });
          // Later periods wait for an unfinished one: it may hold the model's carry-overs.
          if (settlement.state !== 'done' && settlement.state !== 'failed') break;
        }
      });
    });
    return perModel.flat();
  }

  /**
   * Runs one model's work; an error other than a lost lease is logged and alerted and ends
   * only that model's part of the run, so one model cannot block the others (KPR-08).
   */
  async function perModelSafely(
    model: string,
    work: (outcomes: SettlementOutcome[]) => Promise<void>,
  ): Promise<SettlementOutcome[]> {
    const outcomes: SettlementOutcome[] = [];
    try {
      await work(outcomes);
    } catch (err) {
      if (err instanceof LeaseLostError) throw err;
      const error = err instanceof Error ? err.message : String(err);
      log.error({ err, model }, 'settling model failed');
      await ctx.alerter.alert('error', 'settling model failed', { model, error });
      outcomes.push({ model, error });
    }
    return outcomes;
  }

  /**
   * Models to open periods for: every listed one, plus delisted ones that still have
   * billed requests no settlement has tagged (KPR-09), so their revenue is still paid out.
   */
  async function modelsToSettle() {
    const unsettled = await Requests.distinct('modelId', {
      settlementId: null,
      costMicroUsdc: { $gt: 0n },
    });
    return Models.find(
      { $or: [{ status: { $ne: 'delisted' } }, { _id: { $in: unsettled } }] },
      { slug: 1 },
    )
      .sort({ _id: 1 })
      .lean();
  }

  async function lastPeriodStart(modelId: Types.ObjectId): Promise<Date | null> {
    const last = await Settlements.findOne({ modelId }, { periodStart: 1 })
      .sort({ periodStart: -1 })
      .lean();
    return last?.periodStart ?? null;
  }

  async function run(period = settlementPeriod(ctx.clock.now())): Promise<SettlementOutcome[]> {
    const ctx = runCtx();
    const resumed = await resumeIn(ctx);
    const models = await modelsToSettle();
    const perModel = await mapLimit(models, concurrency, (model) =>
      perModelSafely(model.slug, async (outcomes) => {
        for (const missing of periodsToOpen(await lastPeriodStart(model._id), period)) {
          assertLeaseHeld(ctx);
          const doc = await lease(ctx, { modelId: model._id, ...missing });
          if (!doc) {
            outcomes.push({ model: model.slug, skipped: 'already_leased' });
            continue;
          }
          const settlement = await runSettlement(ctx, doc, engine);
          outcomes.push({ model: model.slug, settlement, resumed: false });
          if (settlement.state !== 'done') break;
        }
      }),
    );
    const opened = perModel.flat();
    const failed = opened.filter(
      (o) => 'error' in o || ('settlement' in o && o.settlement.state === 'failed'),
    );
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
