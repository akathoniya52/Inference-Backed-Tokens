import { Leases } from '@ibt/db';
import type { Logger } from 'pino';

import type { Clock } from './ctx.js';

export const LEASE_TTL_MS = 90_000;
export const LEASE_RENEW_MS = 30_000;

export interface LeaseOptions {
  name?: string;
  holder: string;
  ttlMs?: number;
  renewMs?: number;
  clock: Clock;
  logger: Logger;
  onAcquired?: () => void | Promise<void>;
  /** Stops every job (L253). */
  onLost?: () => void | Promise<void>;
}

export interface Lease {
  /** Tries to acquire now, then renews or re-tries every `renewMs`. */
  start(): Promise<void>;
  /** Stops renewing and releases the lease if held. */
  stop(): Promise<void>;
  /** One acquire/renew round; resolves to whether this holder owns the lease. */
  tick(): Promise<boolean>;
  isHeld(): boolean;
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
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<boolean> | null = null;

  async function claim(): Promise<boolean> {
    const now = opts.clock.now();
    try {
      const doc = await Leases.findOneAndUpdate(
        { name, $or: [{ owner: opts.holder }, { expiresAt: { $lte: now } }] },
        { $set: { owner: opts.holder, expiresAt: new Date(now.getTime() + ttlMs) } },
        { upsert: true, new: true },
      ).lean();
      return doc?.owner === opts.holder;
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
      await Leases.deleteOne({ name, owner: opts.holder });
      await notify(opts.onLost, 'lost');
    },
    tick,
    isHeld: () => held,
    pause,
    resume: schedule,
  };
}
