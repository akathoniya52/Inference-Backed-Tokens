import type { Logger } from 'pino';

/** Render's free tier spins a web service down after 15 idle minutes; 30 s keeps it well inside. */
export const SELF_PING_INTERVAL_MS = 30_000;
const SELF_PING_TIMEOUT_MS = 10_000;

export type SelfPingFetch = (
  url: string,
  init: { method: 'GET'; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface SelfPingOptions {
  /** Public base URL of this service; the ping is a no-op when absent (local dev). */
  baseUrl: string | undefined;
  path?: string;
  intervalMs?: number;
  logger: Pick<Logger, 'info' | 'warn' | 'debug'>;
  fetch?: SelfPingFetch;
}

export interface SelfPing {
  ping: () => Promise<void>;
  stop: () => void;
}

/**
 * Pings this service's own public URL on an interval so the host sees inbound traffic.
 * It must be the public URL: a request to localhost never reaches Render's proxy.
 */
export function startSelfPing({
  baseUrl,
  path = '/healthz',
  intervalMs = SELF_PING_INTERVAL_MS,
  logger,
  fetch: doFetch = fetch,
}: SelfPingOptions): SelfPing {
  if (!baseUrl) {
    return { ping: () => Promise.resolve(), stop: () => undefined };
  }
  const url = new URL(path, baseUrl).toString();

  const ping = async (): Promise<void> => {
    try {
      const res = await doFetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(SELF_PING_TIMEOUT_MS),
      });
      if (res.ok) logger.debug({ url }, 'self-ping ok');
      else logger.warn({ url, status: res.status }, 'self-ping got a non-2xx response');
    } catch (err) {
      logger.warn({ url, err }, 'self-ping failed');
    }
  };

  // unref: the timer alone must never keep a shutting-down process alive.
  const timer = setInterval(() => void ping(), intervalMs);
  timer.unref();
  logger.info({ url, intervalMs }, 'self-ping started');

  return { ping, stop: () => clearInterval(timer) };
}
