import {
  CreateModelRequestSchema,
  IdParamsSchema,
  ModelSlugParamsSchema,
  PaginationQuerySchema,
  UpdateModelRequestSchema,
} from '@ibt/shared';
import { Models, type Types } from '@ibt/db';
import { AppError, HealthCheckResponseSchema } from '@ibt/shared';
import { Router } from 'express';

import type { AppContext } from '../../app.js';
import { requireAuthUser } from '../../context.js';
import { jwtAuth } from '../../middleware/jwtAuth.js';
import { createRateLimit } from '../../middleware/rateLimit.js';
import { parseInput } from '../../validate.js';
import { runHealthCheck, type HealthCheckModel } from './health.js';
import { createModel, getModelBySlug, listModels, updateModel } from './service.js';

/** Provider-triggered health checks per user per minute; each one calls the upstream. */
export const HEALTH_CHECK_LIMIT_PER_MIN = 10;

export function modelsRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = jwtAuth(ctx);
  // Per user, after auth: the probe is an outbound request the caller steers.
  const healthCheckLimit = createRateLimit({
    limit: HEALTH_CHECK_LIMIT_PER_MIN,
    keyGenerator: (req) => requireAuthUser(req).userId,
  });

  router.get('/', async (req, res) => {
    res.json(await listModels(parseInput(PaginationQuerySchema, req.query)));
  });

  router.get('/:slug', async (req, res) => {
    const { slug } = parseInput(ModelSlugParamsSchema, req.params);
    res.json(await getModelBySlug(slug));
  });

  router.post('/', auth, async (req, res) => {
    const { userId } = requireAuthUser(req);
    const body = parseInput(CreateModelRequestSchema, req.body);
    res.status(201).json(await createModel(ctx, userId, body));
  });

  router.patch('/:id', auth, async (req, res) => {
    const { userId } = requireAuthUser(req);
    const { id } = parseInput(IdParamsSchema, req.params);
    const patch = parseInput(UpdateModelRequestSchema, req.body);
    res.json(await updateModel(ctx, userId, id, patch));
  });

  router.post('/:id/health-check', auth, healthCheckLimit, async (req, res) => {
    const { userId } = requireAuthUser(req);
    const { id } = parseInput(IdParamsSchema, req.params);
    const model = await Models.findById(id)
      .select({ slug: 1, upstream: 1, status: 1, providerId: 1 })
      .lean<HealthCheckModel & { providerId: Types.ObjectId }>();
    if (!model) throw new AppError('model_not_found');
    if (!model.providerId.equals(userId)) throw new AppError('forbidden');
    res.json(HealthCheckResponseSchema.parse(await runHealthCheck(ctx, model)));
  });

  return router;
}
