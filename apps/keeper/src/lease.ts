import { performance } from 'node:perf_hooks';

import { Leases } from '@ibt/db';
import type { Logger } from 'pino';

import type { LeaseGuard } from './ctx.js';

export const LEASE_TTL_MS = 90_000;
export const LEASE_RENEW_MS = 30_000;

export interface LeaseOptions {
  name?: string;
  holder: string;
  ttlMs?: number;
  renewMs?: number;
  logger: Logger;
  onAcquired?: () => void | Promise<void>;
  /** Stops every job (L253). */
  onLost?: () => void | Promise<void>;
}

export interface Lease extends LeaseGuard {
  /** Tries to acquire now, then renews or re-tries every `renewMs`. */
  start(): Promise<void>;
  /** Stops renewing and releases the lease if held. */
  stop(): Promise<void>;
  /** One acquire/renew round; resolves to whether this holder owns the lease. */
  tick(): Promise<boolean>;
  /** Stops the renew timer without releasing, as a stalled or crashed process would. */
  pause(): void;
  resume(): void;
}

const isDuplicateKey = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;

export function createLease(opts: LeaseOptions): Lease {
  const name = opts.name ?? 'keeper';
  const ttlMs = opts.ttlMs ?? LEASE_TTL_MS;
  const renewMs = opts.renewMs ?? LEASE_RENEW_MS;
  const log = opts.logger.child({ lease: name, holder: opts.holder });
  let held = false;
  let epoch = 0;
  /** `performance.now()` after which an unrenewed claim may already belong to someone else. */
  let deadline = 0;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<boolean> | null = null;

  /**
   * Expiry is judged by the server clock (`$$NOW`), so host clock skew cannot hand the lease
   * to two holders. A new holder's epoch is above the previous one and at least the server
   * time in ms, so it keeps growing even after the TTL index deletes an expired lease doc.
   */
  async function claim(): Promise<boolean> {
    const sentAt = performance.now();
    try {
      const mine = { $eq: ['$owner', opts.holder] };
      // A missing `expiresAt` (fresh upsert) sorts below every date, so it is claimable too.
      const claimable = { $or: [mine, { $lte: ['$expiresAt', '$$NOW'] }] };
      const nextEpoch = {
        $cond: [
          mine,
          { $ifNull: ['$epoch', { $toLong: '$$NOW' }] },
          { $max: [{ $add: [{ $ifNull: ['$epoch', 0] }, 1] }, { $toLong: '$$NOW' }] },
        ],
      };
      const doc = await Leases.findOneAndUpdate(
        { name },
        [
          {
            $set: {
              epoch: { $cond: [claimable, nextEpoch, '$epoch'] },
              owner: { $cond: [claimable, opts.holder, '$owner'] },
              expiresAt: { $cond: [claimable, { $add: ['$$NOW', ttlMs] }, '$expiresAt'] },
            },
          },
        ],
        { upsert: true, new: true },
      ).lean();
      if (doc?.owner !== opts.holder) return false;
      epoch = Number(doc.epoch);
      deadline = sentAt + ttlMs;
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }

  async function notify(hook: (() => void | Promise<void>) | undefined, what: string) {
    try {
      await hook?.();
    } catch (err) {
      log.error({ err }, `lease ${what} hook failed`);
    }
  }

  async function round(): Promise<boolean> {
    let owns: boolean;
    try {
      owns = await claim();
    } catch (err) {
      log.warn({ err }, 'lease round failed');
      owns = false;
    }
    if (owns && !held) {
      held = true;
      log.info('lease acquired');
      await notify(opts.onAcquired, 'acquired');
    } else if (!owns && held) {
      held = false;
      log.warn('lease lost');
      await notify(opts.onLost, 'lost');
    }
    return held;
  }

  function tick(): Promise<boolean> {
    inFlight ??= round().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function schedule(): void {
    timer ??= setInterval(() => {
      void tick();
    }, renewMs);
  }

  function isHeld(): boolean {
    return held && performance.now() < deadline;
  }

  function pause(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    async start() {
      await tick();
      schedule();
    },
    async stop() {
      pause();
      await inFlight;
      if (!held) return;
      held = false;
      // Expire rather than delete, so the next holder's epoch builds on this one.
      await Leases.updateOne({ name, owner: opts.holder }, [{ $set: { expiresAt: '$$NOW' } }]);
      await notify(opts.onLost, 'lost');
    },
    tick,
    isHeld,
    epoch: () => (isHeld() ? epoch : null),
    pause,
    resume: schedule,
  };
}
