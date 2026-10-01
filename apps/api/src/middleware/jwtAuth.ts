import { AppError } from '@ibt/shared';
import type { RequestHandler } from 'express';

import type { AppContext } from '../app.js';
import { setAuthUser } from '../context.js';
import { verifyJwt } from '../modules/auth/service.js';

const BEARER = /^Bearer\s+(\S+)$/i;

/** Requires `Authorization: Bearer <jwt>`; read the user with `requireAuthUser(req)`. */
export function jwtAuth(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const match = BEARER.exec(req.get('Authorization') ?? '');
    if (!match?.[1]) throw new AppError('unauthorized');
    setAuthUser(req, await verifyJwt(ctx, match[1]));
    next();
  };
}
