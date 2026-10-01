import {
  CreateModelRequestSchema,
  IdParamsSchema,
  ModelSlugParamsSchema,
  PaginationQuerySchema,
  UpdateModelRequestSchema,
} from '@ibt/shared';
import { Router } from 'express';

import type { AppContext } from '../../app.js';
import { requireAuthUser } from '../../context.js';
import { jwtAuth } from '../../middleware/jwtAuth.js';
import { parseInput } from '../../validate.js';
import { createModel, getModelBySlug, listModels, updateModel } from './service.js';

export function modelsRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = jwtAuth(ctx);

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

  return router;
}
