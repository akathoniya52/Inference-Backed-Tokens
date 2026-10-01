import { Models, Users, type Types } from '@ibt/db';
import { microToUsdcString, type GatewayModelList } from '@ibt/shared';
import { Router } from 'express';

import type { AppContext } from '../../app.js';
import { apiKeyAuth } from '../../middleware/apiKeyAuth.js';

interface ActiveModelRow {
  _id: Types.ObjectId;
  slug: string;
  providerId: Types.ObjectId;
  pricing: { inputPerMTokMicroUsdc: bigint; outputPerMTokMicroUsdc: bigint };
  createdAt: Date;
}

/** OpenAI-style `GET /v1/models` over active models (L388); P4-T3 adds chat completions. */
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

  return router;
}
