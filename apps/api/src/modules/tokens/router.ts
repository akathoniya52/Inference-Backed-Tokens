import {
  LaunchConfirmRequestSchema,
  LaunchPrepareRequestSchema,
  MintParamsSchema,
  QuoteQuerySchema,
  SettlementsQuerySchema,
  TokenSnapshotsQuerySchema,
} from '@ibt/shared';
import { Router, type ErrorRequestHandler } from 'express';

import type { AppContext } from '../../app.js';
import { getCorrelationId, requireAuthUser } from '../../context.js';
import { jwtAuth } from '../../middleware/jwtAuth.js';
import { createRateLimit } from '../../middleware/rateLimit.js';
import { parseInput } from '../../validate.js';
import { createTokenQuoter, tokenSettlements, tokenSnapshots, tokenState } from './public.js';
import { LaunchConflictError, confirmLaunch, prepareLaunch } from './service.js';

/** API-05: anonymous quotes per client IP per minute; each uncached one reads the chain. */
export const QUOTE_LIMIT_PER_MIN = 60;

const launchConflict: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (!(err instanceof LaunchConflictError)) {
    next(err);
    return;
  }
  const requestId = getCorrelationId(req);
  res.status(409).json({
    error: { code: err.code, message: err.message, ...(requestId ? { requestId } : {}) },
  });
};

export function tokensRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = jwtAuth(ctx);
  const quote = createTokenQuoter(ctx);
  const quoteLimit = createRateLimit({ limit: QUOTE_LIMIT_PER_MIN });

  router.post('/launch/prepare', auth, async (req, res) => {
    const body = parseInput(LaunchPrepareRequestSchema, req.body);
    res.json(await prepareLaunch(ctx, requireAuthUser(req), body));
  });

  router.post('/launch/confirm', auth, async (req, res) => {
    const body = parseInput(LaunchConfirmRequestSchema, req.body);
    res.json(await confirmLaunch(ctx, requireAuthUser(req), body));
  });

  router.get('/:mint/state', async (req, res) => {
    const { mint } = parseInput(MintParamsSchema, req.params);
    res.json(await tokenState(mint));
  });

  router.get('/:mint/snapshots', async (req, res) => {
    const { mint } = parseInput(MintParamsSchema, req.params);
    res.json(await tokenSnapshots(mint, parseInput(TokenSnapshotsQuerySchema, req.query)));
  });

  router.get('/:mint/quote', quoteLimit, async (req, res) => {
    const { mint } = parseInput(MintParamsSchema, req.params);
    res.json(await quote(mint, parseInput(QuoteQuerySchema, req.query)));
  });

  router.get('/:mint/settlements', async (req, res) => {
    const { mint } = parseInput(MintParamsSchema, req.params);
    res.json(await tokenSettlements(mint, parseInput(SettlementsQuerySchema, req.query)));
  });

  router.use(launchConflict);
  return router;
}
