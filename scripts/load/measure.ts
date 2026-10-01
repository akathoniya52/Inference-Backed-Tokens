// Fixed-rate autocannon runs with per-request latencies. autocannon's histogram has no p95,
// so every response time is recorded and the percentiles are computed here.
import autocannon from 'autocannon';

export interface LoadProfile {
  ratePerSec: number;
  durationS: number;
  connections: number;
}

export interface Target {
  url: string;
  path: string;
  body: string;
  /** Called once per built request; returns the per-request headers. */
  headers: () => Record<string, string>;
}

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface RunSummary {
  requests: number;
  non2xx: number;
  errors: number;
  timeouts: number;
  statusCodes: Record<string, number>;
  latencyMs: LatencySummary;
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? Number.NaN;
}

export const roundMs = (ms: number): number => Math.round(ms * 100) / 100;

export function summarize(latencies: readonly number[]): LatencySummary {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: roundMs(percentile(sorted, 50)),
    p95: roundMs(percentile(sorted, 95)),
    p99: roundMs(percentile(sorted, 99)),
    max: roundMs(sorted.at(-1) ?? Number.NaN),
  };
}

export async function runLoad(target: Target, profile: LoadProfile): Promise<RunSummary> {
  const latencies: number[] = [];
  const statusCodes: Record<string, number> = {};

  const options: autocannon.Options = {
    url: target.url,
    connections: profile.connections,
    overallRate: profile.ratePerSec,
    duration: profile.durationS,
    requests: [
      {
        method: 'POST',
        path: target.path,
        body: target.body,
        setupRequest: (request) => ({
          ...request,
          headers: { ...request.headers, ...target.headers() },
        }),
      },
    ],
  };

  const result = await new Promise<autocannon.Result>((resolve, reject) => {
    const instance = autocannon(options, (err: unknown, res: autocannon.Result) => {
      if (err) reject(err instanceof Error ? err : new Error('autocannon failed', { cause: err }));
      else resolve(res);
    });
    // @types/autocannon declares (statusCode, bytes, time) but autocannon 8 emits
    // (client, statusCode, bytes, time); reading from the end works for both.
    instance.on('response', (...args: unknown[]) => {
      const responseTime = args.at(-1);
      const statusCode = args.at(-3);
      if (typeof responseTime === 'number') latencies.push(responseTime);
      if (typeof statusCode === 'number') {
        statusCodes[statusCode] = (statusCodes[statusCode] ?? 0) + 1;
      }
    });
  });

  return {
    requests: latencies.length,
    non2xx: result.non2xx,
    errors: result.errors,
    timeouts: result.timeouts,
    statusCodes,
    latencyMs: summarize(latencies),
  };
}
