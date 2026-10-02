import { randomUUID } from 'node:crypto';

import { Models, Users, type ModelFields, type Types } from '@ibt/db';
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
import { Router } from 'express';

import type { AppContext } from '../../app.js';
import { getRequestId, requireApiKeyContext } from '../../context.js';
import { apiKeyAuth } from '../../middleware/apiKeyAuth.js';
import { createRateLimit } from '../../middleware/rateLimit.js';
import { parseInput } from '../../validate.js';
import { completeChat, type CompletionInput } from './completions.js';
import { createHolderDiscount } from './discount.js';
import {
  abandonIdempotency,
  claimIdempotency,
  completeIdempotency,
  idempotencyKeyOf,
  requestHash,
} from './idempotency.js';
import { streamChat } from './stream.js';

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

export function gatewayRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(apiKeyAuth(ctx));
  // L517: per key, after auth, so one client's keys never share a bucket.
  router.use(
    createRateLimit({
      limit: ctx.env.RATE_LIMIT_PER_MIN ?? RATE_LIMIT_PER_MIN,
      keyGenerator: (req) => requireApiKeyContext(req).apiKeyId,
    }),
  );

  router.get('/models', async (_req, res) => {
    res.json(await listActiveModels());
  });

  const discounts = createHolderDiscount(ctx);
  router.post('/chat/completions', async (req, res) => {
    const key = requireApiKeyContext(req);
    const { body, maxTokens } = validateChatRequest(req.body);
    const idempotencyKey = idempotencyKeyOf(req);
    const requestId = getRequestId(req) ?? randomUUID();
    const prepare = async (): Promise<CompletionInput> => {
      const model = await resolveModel(body.model);
      const discountBps = await discounts.bpsFor(key.wallet, model);
      return { requestId, key, model, body, maxTokens, discountBps };
    };
    if (idempotencyKey === undefined) {
      const input = await prepare();
      if (body.stream === true) {
        await streamChat(ctx, input, res);
        return;
      }
      const result = await completeChat(ctx, input);
      res.set(result.headers).type('application/json').send(result.rawBody);
      return;
    }

    const claim = await claimIdempotency(key.userId, idempotencyKey, requestHash(req.body));
    if (claim.kind === 'replay') {
      const { status, headers, body: stored } = claim.response;
      res
        .status(status)
        .set({ ...headers, [GATEWAY_RESPONSE_HEADERS.idempotencyReplayed]: 'true' })
        .type('application/json')
        .send(stored);
      return;
    }
    try {
      const input = { ...(await prepare()), idempotencyKey };
      if (body.stream === true) {
        // A streamed call is stored, and replayed, as one assembled JSON completion.
        const streamed = await streamChat(ctx, input, res);
        if (streamed === null) {
          await abandonIdempotency(claim.id);
          return;
        }
        await completeIdempotency(claim.id, {
          status: 200,
          headers: streamed.headers,
          body: JSON.stringify(streamed.completion),
        });
        return;
      }
      const result = await completeChat(ctx, input);
      await completeIdempotency(claim.id, {
        status: 200,
        headers: result.headers,
        body: result.rawBody,
      });
      res.set(result.headers).type('application/json').send(result.rawBody);
    } catch (err) {
      await abandonIdempotency(claim.id);
      throw err;
    }
  });

  return router;
}
