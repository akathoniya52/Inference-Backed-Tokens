import { randomUUID } from 'node:crypto';

import { Models, Users, type IdempotencyLock, type ModelFields, type Types } from '@ibt/db';
import {
  AppError,
  ChatCompletionRequestSchema,
  GATEWAY_RESPONSE_HEADERS,
  RATE_LIMIT_PER_MIN,
  effectiveMaxTokens,
  microToUsdcString,
  type ChatCompletionRequest,
  type GatewayModelList,
} from '@ibt/shared';
import { Router, type RequestHandler } from 'express';

import type { AppContext } from '../../app.js';
import { getCorrelationId, getRequestId, requireApiKeyContext } from '../../context.js';
import { upstreamTimeouts } from '../../lib/upstream.js';
import { apiKeyAuth } from '../../middleware/apiKeyAuth.js';
import { createAuthFailureLimit } from '../../middleware/authFailureLimit.js';
import { createRateLimit } from '../../middleware/rateLimit.js';
import { parseInput } from '../../validate.js';
import {
  BilledCallError,
  completeChat,
  type CompletionInput,
  type CompletionResult,
} from './completions.js';
import { createHolderDiscount } from './discount.js';
import {
  IDEMPOTENCY_LOCK_MARGIN_MS,
  claimIdempotency,
  completeIdempotency,
  idempotencyKeyOf,
  notReplayable,
  releaseIdempotency,
  requestHash,
  type StoredResponse,
} from './idempotency.js';
import { streamChat, type StreamOutcome } from './stream.js';
import { assertPromptSize } from './tokenCount.js';

interface ActiveModelRow {
  _id: Types.ObjectId;
  slug: string;
  providerId: Types.ObjectId;
  pricing: { inputPerMTokMicroUsdc: bigint; outputPerMTokMicroUsdc: bigint };
  createdAt: Date;
}

export type ResolvedModel = ModelFields & { _id: Types.ObjectId };

/** Gateway step 2 (L235): unknown or delisted → 404, paused → 503. */
export async function resolveModel(slug: string): Promise<ResolvedModel> {
  const model = await Models.findOne({ slug }).lean<ResolvedModel>();
  if (!model || model.status === 'delisted') throw new AppError('model_not_found');
  if (model.status === 'paused') throw new AppError('model_paused');
  return model;
}

export interface ValidatedChatRequest {
  body: ChatCompletionRequest;
  /** Completion budget for the hold estimate; the schema caps it at `MAX_TOKENS_CAP`. */
  maxTokens: number;
}

export function validateChatRequest(body: unknown): ValidatedChatRequest {
  const parsed = parseInput(ChatCompletionRequestSchema, body);
  const { max_tokens: maxTokens, max_completion_tokens: maxCompletionTokens } = parsed;
  if (maxTokens != null && maxCompletionTokens != null && maxTokens !== maxCompletionTokens) {
    throw new AppError('invalid_request', {
      message: 'max_tokens and max_completion_tokens must match when both are set',
    });
  }
  assertPromptSize(parsed);
  return { body: parsed, maxTokens: effectiveMaxTokens(parsed) };
}

/** OpenAI-style `GET /v1/models` over active models (L386). */
async function listActiveModels(): Promise<GatewayModelList> {
  const rows = await Models.find({ status: 'active' })
    .select({ slug: 1, providerId: 1, pricing: 1, createdAt: 1 })
    .sort({ slug: 1 })
    .lean<ActiveModelRow[]>();
  const providers = await Users.find({ _id: { $in: rows.map((row) => row.providerId) } })
    .select({ wallet: 1 })
    .lean();
  const wallets = new Map(providers.map((user) => [user._id.toHexString(), user.wallet]));
  return {
    object: 'list',
    data: rows.map((row) => ({
      id: row.slug,
      object: 'model',
      created: Math.floor(row.createdAt.getTime() / 1000),
      owned_by: wallets.get(row.providerId.toHexString()) ?? 'unknown',
      pricing: {
        input_per_mtok_usdc: microToUsdcString(row.pricing.inputPerMTokMicroUsdc),
        output_per_mtok_usdc: microToUsdcString(row.pricing.outputPerMTokMicroUsdc),
      },
    })),
  };
}

/** GW-08: requests per client IP per minute, checked before the key is looked up. */
export const GATEWAY_IP_LIMIT_PER_MIN = 6_000;
/** GW-08: failed key lookups per client IP per minute before the IP is refused. */
export const GATEWAY_AUTH_FAILURES_PER_MIN = 30;
/** GW-08: a user's keys together get this many times one key's rate. */
export const USER_RATE_LIMIT_MULTIPLIER = 3;

/**
 * Gateway limits (GW-08). In memory per replica: with several replicas each one
 * enforces them separately, so a multi-replica deployment needs a shared store.
 */
function gatewayLimits(ctx: AppContext): RequestHandler[] {
  const perKey = ctx.env.RATE_LIMIT_PER_MIN ?? RATE_LIMIT_PER_MIN;
  const failures = createAuthFailureLimit({
    limit: GATEWAY_AUTH_FAILURES_PER_MIN,
    clock: ctx.clock,
  });
  return [
    createRateLimit({ limit: GATEWAY_IP_LIMIT_PER_MIN, headers: false }),
    failures.guard,
    apiKeyAuth(
      ctx,
      (req) => {
        failures.recordFailure(req);
      },
      (req) => {
        failures.recordSuccess(req);
      },
    ),
    // L517: per key, after auth, so one client's keys never share a bucket.
    createRateLimit({
      limit: perKey,
      keyGenerator: (req) => `key:${requireApiKeyContext(req).apiKeyId}`,
    }),
    // Many keys of one user share this bucket, so extra keys add no throughput.
    createRateLimit({
      limit: perKey * USER_RATE_LIMIT_MULTIPLIER,
      headers: false,
      keyGenerator: (req) => `user:${requireApiKeyContext(req).userId}`,
    }),
  ];
}

export function gatewayRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(gatewayLimits(ctx));

  router.get('/models', async (_req, res) => {
    res.json(await listActiveModels());
  });

  const discounts = createHolderDiscount(ctx);
  const lockMs = upstreamTimeouts(ctx).totalMs + IDEMPOTENCY_LOCK_MARGIN_MS;

  /** Stores the result of a billed call; a failed write is logged, never a reason to bill again. */
  const storeBilled = async (lock: IdempotencyLock, response: StoredResponse): Promise<void> => {
    try {
      if (!(await completeIdempotency(lock, response))) {
        ctx.logger.error({ idempotencyId: lock.id.toHexString() }, 'idempotency lock lost');
      }
    } catch (err) {
      ctx.logger.error(
        {
          idempotencyId: lock.id.toHexString(),
          errName: err instanceof Error ? err.name : 'unknown',
        },
        'could not store a billed idempotent response; the key stays locked',
      );
    }
  };

  router.post('/chat/completions', async (req, res) => {
    const key = requireApiKeyContext(req);
    const { body, maxTokens } = validateChatRequest(req.body);
    const idempotencyKey = idempotencyKeyOf(req);
    // GW-07: always the server's id; a client `X-Request-Id` only correlates.
    const requestId = getRequestId(req) ?? randomUUID();
    const prepare = async (): Promise<CompletionInput> => {
      const model = await resolveModel(body.model);
      const discountBps = await discounts.bpsFor(key.wallet, model);
      return { requestId, key, model, body, maxTokens, discountBps };
    };
    if (idempotencyKey === undefined) {
      const input = await prepare();
      try {
        if (body.stream === true) {
          await streamChat(ctx, input, res);
          return;
        }
        const result = await completeChat(ctx, input);
        res.set(result.headers).type('application/json').send(result.rawBody);
        return;
      } catch (err) {
        throw err instanceof BilledCallError ? err.original : err;
      }
    }

    const claim = await claimIdempotency(key.userId, idempotencyKey, requestHash(req.body), {
      lockMs,
      now: ctx.clock(),
    });
    if (claim.kind === 'replay') {
      const { status, headers, body: stored } = claim.response;
      res
        .status(status)
        .set({ ...headers, [GATEWAY_RESPONSE_HEADERS.idempotencyReplayed]: 'true' })
        .type('application/json')
        .send(stored);
      return;
    }
    const { lock } = claim;
    /** GW-05: frees the key only when the failed call was never billed. */
    const failed = async (err: unknown): Promise<never> => {
      if (err instanceof BilledCallError) {
        await storeBilled(lock, notReplayable({}, getCorrelationId(req)));
        throw err.original;
      }
      await releaseIdempotency(lock);
      throw err;
    };

    if (body.stream === true) {
      let outcome: StreamOutcome;
      try {
        outcome = await streamChat(ctx, { ...(await prepare()), idempotencyKey }, res);
      } catch (err) {
        return failed(err);
      }
      if (outcome.kind === 'unbilled') {
        await releaseIdempotency(lock);
        return;
      }
      // GW-05: a billed call never frees its key. A complete stream is stored, and
      // replayed, as one assembled JSON completion; a cut one as a terminal error.
      await storeBilled(
        lock,
        outcome.kind === 'completed'
          ? { status: 200, headers: outcome.headers, body: JSON.stringify(outcome.completion) }
          : notReplayable(outcome.headers, getCorrelationId(req)),
      );
      return;
    }

    let result: CompletionResult;
    try {
      result = await completeChat(ctx, { ...(await prepare()), idempotencyKey });
    } catch (err) {
      return failed(err);
    }
    await storeBilled(lock, { status: 200, headers: result.headers, body: result.rawBody });
    res.set(result.headers).type('application/json').send(result.rawBody);
  });

  return router;
}
