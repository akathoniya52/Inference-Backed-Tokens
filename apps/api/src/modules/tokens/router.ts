import {
  LaunchConfirmRequestSchema,
  LaunchPrepareRequestSchema,
  MintParamsSchema,
  QuoteQuerySchema,
  SettlementsQuerySchema,
} from '@ibt/shared';
import { Router, type ErrorRequestHandler } from 'express';

import type { AppContext } from '../../app.js';
import { getRequestId, requireAuthUser } from '../../context.js';
import { jwtAuth } from '../../middleware/jwtAuth.js';
import { parseInput } from '../../validate.js';
import { tokenQuote, tokenSettlements, tokenState } from './public.js';
import { LaunchConflictError, confirmLaunch, prepareLaunch } from './service.js';

const launchConflict: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (!(err instanceof LaunchConflictError)) {
    next(err);
    return;
  }
  const requestId = getRequestId(req);
  res.status(409).json({
    error: { code: err.code, message: err.message, ...(requestId ? { requestId } : {}) },
  });
};

export function tokensRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = jwtAuth(ctx);

  router.post('/launch/prepare', auth, async (req, res) => {
    const body = parseInput(LaunchPrepareRequestSchema, req.body);
    res.json(await prepareLaunch(requireAuthUser(req), body));
  });

  router.post('/launch/confirm', auth, async (req, res) => {
    const body = parseInput(LaunchConfirmRequestSchema, req.body);
    res.json(await confirmLaunch(ctx, requireAuthUser(req), body));
  });

  router.get('/:mint/state', async (req, res) => {
    const { mint } = parseInput(MintParamsSchema, req.params);
    res.json(await tokenState(mint));
  });

  router.get('/:mint/quote', async (req, res) => {
    const { mint } = parseInput(MintParamsSchema, req.params);
    res.json(await tokenQuote(ctx, mint, parseInput(QuoteQuerySchema, req.query)));
  });

  router.get('/:mint/settlements', async (req, res) => {
    const { mint } = parseInput(MintParamsSchema, req.params);
    res.json(await tokenSettlements(mint, parseInput(SettlementsQuerySchema, req.query)));
  });

  router.use(launchConflict);
  return router;
}
