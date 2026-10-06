import { AppError, isAppError } from '@ibt/shared';
import type { Request, RequestHandler } from 'express';

import type { AppContext } from '../app.js';
import { setApiKeyContext } from '../context.js';
import { authenticateKey } from '../modules/keys/service.js';

const BEARER = /^Bearer\s+(\S+)$/i;

/** The bearer token of the `Authorization` header, if any. */
export function bearerKeyOf(req: Request): string | undefined {
  return BEARER.exec(req.get('Authorization') ?? '')?.[1];
}

/**
 * `/v1/*` auth: bearer API key; read it with `requireApiKeyContext(req)`.
 * `onFailure` sees every rejected key and `onSuccess` every accepted one
 * (GW-08 failure limiter).
 */
export function apiKeyAuth(
  ctx: AppContext,
  onFailure?: (req: Request) => void,
  onSuccess?: (req: Request) => void,
): RequestHandler {
  return async (req, _res, next) => {
    try {
      const key = bearerKeyOf(req);
      if (key === undefined) throw new AppError('invalid_api_key');
      setApiKeyContext(req, await authenticateKey(ctx, key));
    } catch (err) {
      if (isAppError(err) && err.code === 'invalid_api_key') onFailure?.(req);
      throw err;
    }
    onSuccess?.(req);
    next();
  };
}
