import type { KeeperCtx } from '../ctx.js';

/** Every 60 s (L250). */
export const HEALTH_CHECK_CRON = '0 * * * * *';
export const HEALTH_CHECK_PATH = '/api/admin/health-checks/run';
const FAILURES_BEFORE_PAUSE = 3;
const PAUSE_MS = 60_000;
const TIMEOUT_MS = 30_000;

export interface HealthCheckOptions {
  /** `API_INTERNAL_URL`. */
  apiUrl: string;
  /** `ADMIN_TOKEN`; sent as a bearer token and never logged. */
  adminToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  pauseMs?: number;
}

export type HealthCheckResult =
  | { status: 'ok'; httpStatus: number }
  | { status: 'failed'; httpStatus: number | null; consecutiveFailures: number }
  | { status: 'paused'; until: Date };

export interface HealthCheckJob {
  tick(): Promise<HealthCheckResult>;
}

/**
 * G12: the health checks run in the api, which owns the upstream keys; the keeper only
 * triggers them. Non-2xx or network errors are logged and alerted; after three in a row
 * the job pauses for 60 s (L250) so a down api is not hammered.
 */
export function createHealthCheckJob(
  ctx: Pick<KeeperCtx, 'logger' | 'alerter' | 'clock'>,
  opts: HealthCheckOptions,
): HealthCheckJob {
  const log = ctx.logger.child({ job: 'healthCheck' });
  const doFetch = opts.fetch ?? fetch;
  const url = new URL(HEALTH_CHECK_PATH, opts.apiUrl).toString();
  const pauseMs = opts.pauseMs ?? PAUSE_MS;
  let failures = 0;
  let pausedUntil: Date | null = null;

  async function call(): Promise<{ ok: boolean; httpStatus: number | null; error?: string }> {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.adminToken}`, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      });
      const body = await res.text();
      if (res.ok)
        log.debug({ httpStatus: res.status, body: body.slice(0, 500) }, 'health checks ran');
      return { ok: res.ok, httpStatus: res.status };
    } catch (err) {
      return {
        ok: false,
        httpStatus: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    async tick() {
      const now = ctx.clock.now();
      if (pausedUntil && now < pausedUntil) return { status: 'paused', until: pausedUntil };
      pausedUntil = null;

      const { ok, httpStatus, error } = await call();
      if (ok && httpStatus !== null) {
        failures = 0;
        return { status: 'ok', httpStatus };
      }
      failures += 1;
      log.warn({ httpStatus, error, consecutiveFailures: failures }, 'health check run failed');
      await ctx.alerter.alert('warn', 'health check run failed', {
        httpStatus,
        error,
        consecutiveFailures: failures,
      });
      const consecutiveFailures = failures;
      if (failures >= FAILURES_BEFORE_PAUSE) {
        pausedUntil = new Date(now.getTime() + pauseMs);
        failures = 0;
        await ctx.alerter.alert('error', 'health check job paused', {
          until: pausedUntil.toISOString(),
          consecutiveFailures,
        });
      }
      return { status: 'failed', httpStatus, consecutiveFailures };
    },
  };
}
