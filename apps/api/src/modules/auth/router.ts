import { NonceRequestSchema, VerifyRequestSchema } from '@ibt/shared';
import { Router } from 'express';

import type { AppContext } from '../../app.js';
import { requireAuthUser } from '../../context.js';
import { jwtAuth } from '../../middleware/jwtAuth.js';
import { createRateLimit } from '../../middleware/rateLimit.js';
import { parseInput } from '../../validate.js';
import { issueNonce, revokeSessions, verifySignIn } from './service.js';

/**
 * API-10: one bucket per endpoint and client IP, so a sign-in (nonce + verify)
 * costs one request from each and users behind one NAT do not lock each other out.
 */
export const NONCE_LIMIT_PER_MIN = 20;
export const VERIFY_LIMIT_PER_MIN = 20;
export const LOGOUT_LIMIT_PER_MIN = 10;

export function authRouter(ctx: AppContext): Router {
  const router = Router();
  const nonceLimit = createRateLimit({ limit: NONCE_LIMIT_PER_MIN });
  const verifyLimit = createRateLimit({ limit: VERIFY_LIMIT_PER_MIN });
  const logoutLimit = createRateLimit({ limit: LOGOUT_LIMIT_PER_MIN });

  router.post('/nonce', nonceLimit, async (req, res) => {
    const { wallet } = parseInput(NonceRequestSchema, req.body);
    res.json(await issueNonce(ctx, wallet));
  });

  // The spec body is `{wallet, signature}` (L388); `nonce` is required on top so
  // verify checks the exact issued nonce before it is consumed.
  router.post('/verify', verifyLimit, async (req, res) => {
    const body = parseInput(VerifyRequestSchema, req.body);
    res.json(await verifySignIn(ctx, body));
  });

  router.post('/logout', logoutLimit, jwtAuth(ctx), async (req, res) => {
    await revokeSessions(requireAuthUser(req).userId);
    res.status(204).end();
  });

  return router;
}
