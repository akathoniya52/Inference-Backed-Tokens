import { NonceRequestSchema, VerifyRequestSchema } from '@ibt/shared';
import { Router } from 'express';

import type { AppContext } from '../../app.js';
import { requireAuthUser } from '../../context.js';
import { jwtAuth } from '../../middleware/jwtAuth.js';
import { createRateLimit } from '../../middleware/rateLimit.js';
import { parseInput } from '../../validate.js';
import { issueNonce, revokeSessions, verifySignIn } from './service.js';

const AUTH_LIMIT_PER_MIN = 10;

export function authRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(createRateLimit({ limit: AUTH_LIMIT_PER_MIN }));

  router.post('/nonce', async (req, res) => {
    const { wallet } = parseInput(NonceRequestSchema, req.body);
    res.json(await issueNonce(ctx, wallet));
  });

  // The spec body is `{wallet, signature}` (L388); `nonce` is required on top so
  // verify checks the exact issued nonce before it is consumed.
  router.post('/verify', async (req, res) => {
    const body = parseInput(VerifyRequestSchema, req.body);
    res.json(await verifySignIn(ctx, body));
  });

  router.post('/logout', jwtAuth(ctx), async (req, res) => {
    await revokeSessions(requireAuthUser(req).userId);
    res.status(204).end();
  });

  return router;
}
