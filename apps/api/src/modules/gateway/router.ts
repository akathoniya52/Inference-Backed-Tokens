import { randomUUID } from 'node:crypto';

import { Models, Users, type ModelFields, type Types } from '@ibt/db';
import {
  AppError,
  ChatCompletionRequestSchema,
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
import { completeChat } from './completions.js';

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

/** OpenAI-style `GET /v1/models` over active models (L388). */
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

  router.post('/chat/completions', async (req, res) => {
    const key = requireApiKeyContext(req);
    const { body, maxTokens } = validateChatRequest(req.body);
    if (body.stream === true) {
      throw new AppError('invalid_request', { message: 'streaming is not supported' });
    }
    const model = await resolveModel(body.model);
    const result = await completeChat(ctx, {
      requestId: getRequestId(req) ?? randomUUID(),
      key,
      model,
      body,
      maxTokens,
    });
    res.set(result.headers).type('application/json').send(result.rawBody);
  });

  return router;
}
