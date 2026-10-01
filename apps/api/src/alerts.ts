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

class RollingWindow {
  private readonly times: number[] = [];

  constructor(private readonly windowMs: number) {}

  add(now: number): void {
    this.times.push(now);
    this.prune(now);
  }

  count(now: number): number {
    this.prune(now);
    return this.times.length;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let stale = 0;
    while (stale < this.times.length && (this.times[stale] ?? 0) <= cutoff) stale += 1;
    if (stale > 0) this.times.splice(0, stale);
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
  const responses = new RollingWindow(ERROR_RATE_WINDOW_MS);
  const serverErrors = new RollingWindow(ERROR_RATE_WINDOW_MS);
  const rejectedDeposits = new RollingWindow(REJECTED_DEPOSITS_WINDOW_MS);
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

    modelPaused(event) {
      send('error', 'model paused', event);
    },

    middleware() {
      return (_req, res, next) => {
        res.on('finish', () => {
          api.recordResponse(res.statusCode);
        });
        next();
      };
    },
  };
  return api;
}
