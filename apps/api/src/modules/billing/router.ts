import { DepositRequestSchema, PaginationQuerySchema, UsageQuerySchema } from '@ibt/shared';
import { Router } from 'express';

import type { AppContext } from '../../app.js';
import { requireAuthUser } from '../../context.js';
import { jwtAuth } from '../../middleware/jwtAuth.js';
import { createRateLimit } from '../../middleware/rateLimit.js';
import { parseInput } from '../../validate.js';
import { listLedger, me, submitDeposit, usage } from './service.js';

const DEPOSIT_LIMIT_PER_MIN = 10;

export function billingRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(jwtAuth(ctx));

  // L523: per user, so a shared NAT does not throttle unrelated wallets.
  const depositLimit = createRateLimit({
    limit: DEPOSIT_LIMIT_PER_MIN,
    keyGenerator: (req) => requireAuthUser(req).userId,
  });

  router.post('/deposits', depositLimit, async (req, res) => {
    const { userId } = requireAuthUser(req);
    const { txSignature } = parseInput(DepositRequestSchema, req.body);
    res.json(await submitDeposit(ctx, userId, txSignature));
  });

  router.get('/ledger', async (req, res) => {
    const { userId } = requireAuthUser(req);
    res.json(await listLedger(userId, parseInput(PaginationQuerySchema, req.query)));
  });

  router.get('/usage', async (req, res) => {
    const { userId } = requireAuthUser(req);
    res.json(await usage(ctx, userId, parseInput(UsageQuerySchema, req.query)));
  });

  return router;
}

export function meRouter(ctx: AppContext): Router {
  const router = Router();
  router.get('/', jwtAuth(ctx), async (req, res) => {
    res.json(await me(requireAuthUser(req).userId));
  });
  return router;
}
