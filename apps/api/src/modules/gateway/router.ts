import { Models, Users, type ModelFields, type Types } from '@ibt/db';
import {
  AppError,
  ChatCompletionRequestSchema,
  effectiveMaxTokens,
  microToUsdcString,
  type ChatCompletionRequest,
  type GatewayModelList,
} from '@ibt/shared';
import { Router } from 'express';

import type { AppContext } from '../../app.js';
import { getRequestId } from '../../context.js';
import { apiKeyAuth } from '../../middleware/apiKeyAuth.js';
import { parseInput } from '../../validate.js';

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

  router.get('/models', async (_req, res) => {
    res.json(await listActiveModels());
  });

  router.post('/chat/completions', async (req, res) => {
    const { body } = validateChatRequest(req.body);
    await resolveModel(body.model);
    // Forwarding, billing and streaming land in P4-T4.
    res.status(501).json({
      error: {
        code: 'not_implemented',
        message: 'chat completions are not available yet',
        requestId: getRequestId(req),
      },
    });
  });

  return router;
}
