import { CreateApiKeyRequestSchema, IdParamsSchema, PaginationQuerySchema } from '@ibt/shared';
import { Router } from 'express';

import type { AppContext } from '../../app.js';
import { requireAuthUser } from '../../context.js';
import { jwtAuth } from '../../middleware/jwtAuth.js';
import { createRateLimit } from '../../middleware/rateLimit.js';
import { parseInput } from '../../validate.js';
import { createKey, listKeys, revokeKey } from './service.js';

/** GW-08: key creations per user per minute. */
export const KEY_CREATE_LIMIT_PER_MIN = 10;

export function keysRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(jwtAuth(ctx));
  const createLimit = createRateLimit({
    limit: KEY_CREATE_LIMIT_PER_MIN,
    keyGenerator: (req) => requireAuthUser(req).userId,
  });

  router.get('/', async (req, res) => {
    const { userId } = requireAuthUser(req);
    res.json(await listKeys(userId, parseInput(PaginationQuerySchema, req.query)));
  });

  router.post('/', createLimit, async (req, res) => {
    const { userId } = requireAuthUser(req);
    const body = parseInput(CreateApiKeyRequestSchema, req.body);
    res.status(201).json(await createKey(ctx, userId, body));
  });

  router.delete('/:id', async (req, res) => {
    const { userId } = requireAuthUser(req);
    const { id } = parseInput(IdParamsSchema, req.params);
    res.json(await revokeKey(userId, id));
  });

  return router;
}
