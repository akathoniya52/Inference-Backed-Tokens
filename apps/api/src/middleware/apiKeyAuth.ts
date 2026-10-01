import { AppError } from '@ibt/shared';
import type { RequestHandler } from 'express';

import type { AppContext } from '../app.js';
import { setApiKeyContext } from '../context.js';
import { authenticateKey } from '../modules/keys/service.js';

const BEARER = /^Bearer\s+(\S+)$/i;

/** `/v1/*` auth: bearer API key; read it with `requireApiKeyContext(req)`. */
export function apiKeyAuth(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const match = BEARER.exec(req.get('Authorization') ?? '');
    if (!match?.[1]) throw new AppError('invalid_api_key');
    setApiKeyContext(req, await authenticateKey(ctx, match[1]));
    next();
  };
}
