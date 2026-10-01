import { NonceRequestSchema, NonceResponseSchema, VerifyRequestSchema } from '@ibt/shared';
import { Router } from 'express';

import type { AppContext } from '../../app.js';
import { createRateLimit } from '../../middleware/rateLimit.js';
import { parseInput } from '../../validate.js';
import { issueNonce, verifySignIn } from './service.js';

const AUTH_LIMIT_PER_MIN = 10;

// The spec body is `{wallet, signature}` (L389); `nonce` pins a specific
// issued nonce and is optional so the shared schema stays the contract.
const VerifyBodySchema = VerifyRequestSchema.extend({
  nonce: NonceResponseSchema.shape.nonce.max(128).optional(),
});

export function authRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(createRateLimit({ limit: AUTH_LIMIT_PER_MIN }));

  router.post('/nonce', async (req, res) => {
    const { wallet } = parseInput(NonceRequestSchema, req.body);
    res.json(await issueNonce(ctx, wallet));
  });

  router.post('/verify', async (req, res) => {
    const body = parseInput(VerifyBodySchema, req.body);
    res.json(await verifySignIn(ctx, body));
  });

  return router;
}
