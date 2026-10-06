import { createHash, timingSafeEqual } from 'node:crypto';

import { AppError } from '@ibt/shared';
import type { RequestHandler } from 'express';

import type { AppContext } from '../app.js';
import type { ApiEnv } from '../env.js';

const BEARER = /^Bearer\s+(\S+)$/i;
const IPV4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost']);

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

export function normalizeIp(ip: string | undefined): string {
  const value = ip ?? '';
  return IPV4_MAPPED.exec(value)?.[1] ?? value;
}

/**
 * A loopback-only allowlist is satisfied by any client that reaches the api
 * directly and sends `X-Forwarded-For: 127.0.0.1` while `trust proxy` is on.
 */
export function loopbackAllowlistBehindProxy(
  env: Pick<ApiEnv, 'ADMIN_IP_ALLOWLIST' | 'TRUST_PROXY'>,
): boolean {
  const allowlist = env.ADMIN_IP_ALLOWLIST.map(normalizeIp);
  return (
    allowlist.length > 0 &&
    allowlist.every((ip) => LOOPBACK_ADDRESSES.has(ip)) &&
    env.TRUST_PROXY !== false &&
    env.TRUST_PROXY !== 0
  );
}

/**
 * API-01: any allowlist is spoofable from a direct connection while `trust proxy`
 * believes every hop (`true`) or a hop count, since the client writes the
 * left-most `X-Forwarded-For` entries. A subnet list trusts only named proxies.
 */
export function allowlistTrustsAnyHop(
  env: Pick<ApiEnv, 'ADMIN_IP_ALLOWLIST' | 'TRUST_PROXY'>,
): boolean {
  const trust = env.TRUST_PROXY;
  return (
    env.ADMIN_IP_ALLOWLIST.length > 0 &&
    (trust === true || (typeof trust === 'number' && trust > 0))
  );
}

/**
 * `/api/admin/*` (L230): the client IP (`req.ip`, so `trust proxy` applies)
 * must be in `ADMIN_IP_ALLOWLIST` (empty = any), then the bearer must equal
 * `ADMIN_TOKEN`. Both sides are hashed first so `timingSafeEqual` compares
 * equal lengths and the token length does not leak.
 */
export function adminAuth(ctx: AppContext): RequestHandler {
  const expected = digest(ctx.env.ADMIN_TOKEN);
  const allowlist = new Set(ctx.env.ADMIN_IP_ALLOWLIST.map(normalizeIp));
  return (req, _res, next) => {
    if (allowlist.size > 0 && !allowlist.has(normalizeIp(req.ip))) {
      throw new AppError('forbidden', { message: 'client address is not allowed' });
    }
    const token = BEARER.exec(req.get('Authorization') ?? '')?.[1];
    if (token === undefined || !timingSafeEqual(digest(token), expected)) {
      throw new AppError('unauthorized', { message: 'admin token required' });
    }
    next();
  };
}
