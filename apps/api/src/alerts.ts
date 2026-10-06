import type { Alerter } from '@ibt/shared/node';
import type { RequestHandler } from 'express';
import type { Logger } from 'pino';

import type { Clock } from './context.js';

// Rolling alert thresholds (L530).
export const ERROR_RATE_WINDOW_MS = 5 * 60 * 1000;
export const ERROR_RATE_THRESHOLD = 0.02;
/**
 * Fewer responses than this in the window never alert: one 5xx out of a
 * handful of requests is noise, not a 2% error rate.
 */
export const ERROR_RATE_MIN_SAMPLE = 50;
export const REJECTED_DEPOSITS_WINDOW_MS = 60 * 60 * 1000;
export const REJECTED_DEPOSITS_THRESHOLD = 5;

const BUCKET_MS = 1000;

/**
 * API-13: a ring of per-second counters over the window, so memory is fixed
 * (one slot per second) and every call is O(window seconds) at worst, whatever
 * the request rate.
 */
class RollingCounter {
  private readonly seconds: number[];
  private readonly counts: number[];

  constructor(windowMs: number) {
    const slots = Math.max(1, Math.ceil(windowMs / BUCKET_MS));
    this.seconds = new Array<number>(slots).fill(-1);
    this.counts = new Array<number>(slots).fill(0);
  }

  add(now: number): void {
    const second = Math.floor(now / BUCKET_MS);
    const slot = second % this.seconds.length;
    if (this.seconds[slot] !== second) {
      this.seconds[slot] = second;
      this.counts[slot] = 0;
    }
    this.counts[slot] = (this.counts[slot] ?? 0) + 1;
  }

  count(now: number): number {
    const second = Math.floor(now / BUCKET_MS);
    const oldest = second - this.seconds.length;
    let total = 0;
    for (let slot = 0; slot < this.seconds.length; slot += 1) {
      const at = this.seconds[slot] ?? -1;
      if (at > oldest && at <= second) total += this.counts[slot] ?? 0;
    }
    return total;
  }
}

export interface ModelPausedEvent {
  modelId: string;
  slug: string;
  reason: 'health_check' | 'admin' | 'owner';
  [key: string]: string | number | boolean | null;
}

export interface ApiAlerts {
  recordResponse(status: number): void;
  recordRejectedDeposit(): void;
  /**
   * API-12: counts this response as a 5xx even though its status line already
   * went out (an error after the headers, a failed stream).
   */
  markFailed(res: object): void;
  modelPaused(event: ModelPausedEvent): void;
  middleware(): RequestHandler;
}

export interface ApiAlertsDeps {
  alerter: Alerter;
  clock: Clock;
  logger: Logger;
}

/**
 * Process-local rolling counters. Each condition alerts once when it trips and
 * stays quiet until it has cleared, so a sustained outage is one alert.
 */
export function createApiAlerts({ alerter, clock, logger }: ApiAlertsDeps): ApiAlerts {
  const responses = new RollingCounter(ERROR_RATE_WINDOW_MS);
  const serverErrors = new RollingCounter(ERROR_RATE_WINDOW_MS);
  const rejectedDeposits = new RollingCounter(REJECTED_DEPOSITS_WINDOW_MS);
  const failed = new WeakSet<object>();
  let errorRateTripped = false;
  let depositsTripped = false;

  const send = (
    level: 'warn' | 'error',
    title: string,
    body: Record<string, string | number | boolean | null>,
  ) => {
    alerter.alert(level, title, body).catch((err: unknown) => {
      logger.error({ errName: err instanceof Error ? err.name : 'unknown', title }, 'alert failed');
    });
  };

  const api: ApiAlerts = {
    recordResponse(status) {
      const now = clock().getTime();
      responses.add(now);
      if (status >= 500) serverErrors.add(now);
      const total = responses.count(now);
      const errors = serverErrors.count(now);
      const rate = total === 0 ? 0 : errors / total;
      const over = total >= ERROR_RATE_MIN_SAMPLE && rate > ERROR_RATE_THRESHOLD;
      if (over && !errorRateTripped) {
        send('error', '5xx rate above 2% over 5 minutes', {
          errors,
          total,
          ratePct: Math.round(rate * 10_000) / 100,
        });
      }
      errorRateTripped = over;
    },

    recordRejectedDeposit() {
      const now = clock().getTime();
      rejectedDeposits.add(now);
      const count = rejectedDeposits.count(now);
      const over = count > REJECTED_DEPOSITS_THRESHOLD;
      if (over && !depositsTripped) {
        send('warn', 'more than 5 rejected deposits in an hour', { count });
      }
      depositsTripped = over;
    },

    markFailed(res) {
      failed.add(res);
    },

    modelPaused(event) {
      send('error', 'model paused', event);
    },

    middleware() {
      return (_req, res, next) => {
        let recorded = false;
        // `close` without `finish` is a destroyed response (an error mid-stream).
        const record = (): void => {
          if (recorded) return;
          recorded = true;
          api.recordResponse(failed.has(res) ? 500 : res.statusCode);
        };
        res.on('finish', record);
        res.on('close', record);
        next();
      };
    },
  };
  return api;
}
