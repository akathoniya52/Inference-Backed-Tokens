import { AppError } from '@ibt/shared';
import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

export interface RateLimitOptions {
  limit: number;
  windowMs?: number;
  /** Defaults to the client IP (honours `trust proxy`). */
  keyGenerator?: (req: Parameters<RequestHandler>[0]) => string;
}

/** Fixed-window limiter that answers with the 429 `rate_limited` envelope. */
export function createRateLimit({
  limit,
  windowMs = 60_000,
  keyGenerator,
}: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (_req, _res, next) => {
      next(new AppError('rate_limited'));
    },
  });
}
