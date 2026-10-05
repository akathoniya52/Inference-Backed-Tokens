import { IdParamsSchema } from '@ibt/shared';
import { Router } from 'express';

import type { AppContext } from '../../app.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { createRateLimit } from '../../middleware/rateLimit.js';
import { parseInput } from '../../validate.js';
import { floatStatus, pauseModel, retrySettlement, runAllHealthChecks } from './service.js';

const ADMIN_LIMIT_PER_MIN = 30;

export function adminRouter(ctx: AppContext): Router {
  const router = Router();
  // Ahead of adminAuth so failed token guesses count too.
  router.use(createRateLimit({ limit: ADMIN_LIMIT_PER_MIN }));
  router.use(adminAuth(ctx));

  router.post('/settlements/:id/retry', async (req, res) => {
    const { id } = parseInput(IdParamsSchema, req.params);
    res.json(await retrySettlement(ctx, id));
  });

  router.post('/models/:id/pause', async (req, res) => {
    const { id } = parseInput(IdParamsSchema, req.params);
    res.json((await pauseModel(ctx, id)).response);
  });

  router.get('/float', async (_req, res) => {
    res.json(await floatStatus(ctx));
  });

  router.post('/health-checks/run', async (_req, res) => {
    res.json(await runAllHealthChecks(ctx));
  });

  return router;
}
