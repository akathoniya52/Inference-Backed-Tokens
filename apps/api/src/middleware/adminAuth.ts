import { createHash, timingSafeEqual } from 'node:crypto';

import { AppError } from '@ibt/shared';
import type { RequestHandler } from 'express';

import type { AppContext } from '../app.js';

const BEARER = /^Bearer\s+(\S+)$/i;
const IPV4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

export function normalizeIp(ip: string | undefined): string {
  const value = ip ?? '';
  return IPV4_MAPPED.exec(value)?.[1] ?? value;
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
