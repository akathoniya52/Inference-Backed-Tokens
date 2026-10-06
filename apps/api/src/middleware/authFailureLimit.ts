import { createHash } from 'node:crypto';

import { AppError } from '@ibt/shared';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

import type { Clock } from '../context.js';
import { bearerKeyOf } from './apiKeyAuth.js';

export interface AuthFailureLimitOptions {
  /** Failed authentications per client IP per window before the IP is refused. */
  limit: number;
  windowMs?: number;
  /** IPs tracked at once; expired windows go first, then the oldest. */
  maxTracked?: number;
  /** Recently authenticated keys remembered at once; the least recently seen go first. */
  maxKnownKeys?: number;
  knownKeyTtlMs?: number;
  clock: Clock;
}

export interface AuthFailureLimit {
  /**
   * Runs before auth: refuses an IP that already failed `limit` times this
   * window, unless the request's key recently authenticated.
   */
  guard: RequestHandler;
  /** Counts one failed authentication for the request's IP. */
  recordFailure(req: Request): void;
  /** Remembers the request's key as recently authenticated. */
  recordSuccess(req: Request): void;
  /** Keys remembered right now (tests). */
  knownKeyCount(): number;
}

interface Window {
  start: number;
  failures: number;
}

/** SHA-256 of the bearer key; the raw key is never kept. */
function bearerHashOf(req: Request): string | undefined {
  const key = bearerKeyOf(req);
  return key === undefined ? undefined : createHash('sha256').update(key).digest('hex');
}

/**
 * GW-08: invalid-key floods are refused before they reach Mongo. Only failures
 * count, so a busy client with valid keys is never throttled here (the per-key
 * and per-user buckets do that). An IP shared by many clients (a NAT, or a
 * load balancer without `TRUST_PROXY`) can be blocked by one of them, so a key
 * that recently authenticated passes the IP block (it is still fully
 * authenticated); unknown keys stay refused. Process-local; several replicas
 * each keep their own counts, so a multi-replica deployment needs a shared store.
 */
export function createAuthFailureLimit({
  limit,
  windowMs = 60_000,
  maxTracked = 10_000,
  maxKnownKeys = 10_000,
  knownKeyTtlMs = 10 * 60_000,
  clock,
}: AuthFailureLimitOptions): AuthFailureLimit {
  const windows = new Map<string, Window>();
  // Key hash → last success; Map order is least recently seen first.
  const knownKeys = new Map<string, number>();
  const isKnown = (req: Request, now: number): boolean => {
    const hash = bearerHashOf(req);
    const seen = hash === undefined ? undefined : knownKeys.get(hash);
    return seen !== undefined && now >= seen && now - seen < knownKeyTtlMs;
  };
  // IPv6 clients are bucketed per /56, as express-rate-limit does.
  const keyOf = (req: Request): string => ipKeyGenerator(req.ip ?? '', 56);
  const live = (entry: Window | undefined, now: number): entry is Window =>
    entry !== undefined && now >= entry.start && now - entry.start < windowMs;

  return {
    guard: (req, _res, next) => {
      const now = clock().getTime();
      const entry = windows.get(keyOf(req));
      if (live(entry, now) && entry.failures >= limit && !isKnown(req, now)) {
        next(new AppError('rate_limited'));
        return;
      }
      next();
    },
    recordSuccess(req) {
      const hash = bearerHashOf(req);
      if (hash === undefined) return;
      knownKeys.delete(hash);
      if (knownKeys.size >= maxKnownKeys) {
        const oldest = knownKeys.keys().next();
        if (!oldest.done) knownKeys.delete(oldest.value);
      }
      knownKeys.set(hash, clock().getTime());
    },
    knownKeyCount: () => knownKeys.size,
    recordFailure(req) {
      const now = clock().getTime();
      const key = keyOf(req);
      const entry = windows.get(key);
      if (live(entry, now)) {
        entry.failures += 1;
        return;
      }
      windows.delete(key);
      if (windows.size >= maxTracked) {
        for (const [tracked, window] of windows) {
          if (!live(window, now)) windows.delete(tracked);
        }
        for (const tracked of windows.keys()) {
          if (windows.size < maxTracked) break;
          windows.delete(tracked);
        }
      }
      windows.set(key, { start: now, failures: 1 });
    },
  };
}
