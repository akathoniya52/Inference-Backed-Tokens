import { Models, Types, Users, type ModelFields } from '@ibt/db';
import {
  AppError,
  ModelSchema,
  OwnerModelSchema,
  lamportsToSol,
  microToUsdcString,
  usdcStringToMicro,
  type CreateModelRequest,
  type ListModelsResponse,
  type Model,
  type OwnerModel,
  type PaginationQuery,
  type UpdateModelRequest,
} from '@ibt/shared';
import { encrypt } from '@ibt/shared/node';

import type { AppContext } from '../../app.js';
import { isDuplicateKey } from '../../lib/mongoErrors.js';
import { cursorFilter, toPage } from '../../pagination.js';

type ModelRow = ModelFields & { _id: Types.ObjectId; createdAt: Date };

/** Statuses visible in the public registry. */
const PUBLIC_STATUSES = ['active', 'paused'] as const;

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function toPublicFields(row: ModelRow, providerWallet: string) {
  return {
    id: row._id.toHexString(),
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    imageUrl: row.imageUrl ?? null,
    providerWallet,
    status: row.status,
    pricing: {
      inputPerMTokUsdc: microToUsdcString(row.pricing.inputPerMTokMicroUsdc),
      outputPerMTokUsdc: microToUsdcString(row.pricing.outputPerMTokMicroUsdc),
    },
    splits: {
      providerBps: row.splits.providerBps,
      liquidityBps: row.splits.liquidityBps,
      platformBps: row.splits.platformBps,
    },
    health: {
      lastOkAt: iso(row.health.lastOkAt),
      p50LatencyMs: row.health.p50LatencyMs ?? null,
      consecutiveFailures: row.health.consecutiveFailures,
    },
    token: {
      status: row.token.status,
      symbol: row.token.symbol ?? null,
      mint: row.token.mint ?? null,
      dbcPool: row.token.dbcPool ?? null,
      dammV2Pool: row.token.dammV2Pool ?? null,
      launchSignature: row.token.launchSignature ?? null,
      migrationSignature: row.token.migrationSignature ?? null,
      keeperPosition: row.token.keeperPosition ?? null,
    },
    stats: {
      requests24h: row.stats.requests,
      successRate: row.stats.successRate,
      revenueUsdc24h: microToUsdcString(row.stats.revenueMicroUsdc),
      lockedLiquiditySol: lamportsToSol(row.stats.lockedLiquidityLamports),
    },
    createdAt: row.createdAt.toISOString(),
  };
}

// Both views go through a stripping zod object, so `upstream.apiKeyEnc` (or any
// other stored field) can never reach a response body (L225, L516).

function toPublicDto(row: ModelRow, providerWallet: string): Model {
  return ModelSchema.parse(toPublicFields(row, providerWallet));
}

function toOwnerDto(row: ModelRow, providerWallet: string): OwnerModel {
  return OwnerModelSchema.parse({ ...toPublicFields(row, providerWallet), upstream: row.upstream });
}

async function providerWallets(rows: ModelRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.providerId.toHexString()))];
  const users = await Users.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
    .select({ wallet: 1 })
    .lean();
  return new Map(users.map((user) => [user._id.toHexString(), user.wallet]));
}

async function walletOf(row: ModelRow): Promise<string> {
  const wallet = (await providerWallets([row])).get(row.providerId.toHexString());
  if (wallet === undefined) throw new AppError('internal', { message: 'model provider missing' });
  return wallet;
}

export async function listModels(query: PaginationQuery): Promise<ListModelsResponse> {
  const rows = await Models.find({
    status: { $in: PUBLIC_STATUSES },
    ...cursorFilter(query.cursor),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean<ModelRow[]>();
  const page = toPage(rows, query.limit);
  const wallets = await providerWallets(page.rows);
  return {
    items: page.rows.flatMap((row) => {
      const wallet = wallets.get(row.providerId.toHexString());
      return wallet === undefined ? [] : [toPublicDto(row, wallet)];
    }),
    nextCursor: page.nextCursor,
  };
}

export async function getModelBySlug(slug: string): Promise<Model> {
  const row = await Models.findOne({ slug, status: { $in: PUBLIC_STATUSES } }).lean<ModelRow>();
  if (!row) throw new AppError('model_not_found');
  return toPublicDto(row, await walletOf(row));
}

export async function createModel(
  ctx: AppContext,
  userId: string,
  input: CreateModelRequest,
): Promise<OwnerModel> {
  const providerId = new Types.ObjectId(userId);
  let created: ModelRow;
  try {
    const doc = await Models.create({
      providerId,
      slug: input.slug,
      name: input.name,
      description: input.description,
      imageUrl: input.imageUrl ?? null,
      upstream: {
        baseUrl: input.upstream.baseUrl,
        modelName: input.upstream.modelName,
        apiKeyEnc: encrypt(input.upstream.apiKey, ctx.env.MASTER_KEY),
        supportsStreamUsage: input.upstream.supportsStreamUsage,
      },
      pricing: {
        inputPerMTokMicroUsdc: usdcStringToMicro(input.pricing.inputPerMTokUsdc),
        outputPerMTokMicroUsdc: usdcStringToMicro(input.pricing.outputPerMTokUsdc),
      },
    });
    created = doc.toObject<ModelRow>();
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw new AppError('invalid_request', { message: 'slug is already taken', cause: err });
    }
    throw err;
  }
  // Admins keep their role; consumers become providers (L392).
  await Users.updateOne({ _id: providerId, role: 'consumer' }, { $set: { role: 'provider' } });
  return toOwnerDto(created, await walletOf(created));
}

/**
 * API-02: the owner lifts only their own pause. An admin pause stays until an
 * admin lifts it; a health (or unattributed, pre-`pausedBy`) pause only once a
 * health check has passed since, which resets `consecutiveFailures`.
 */
function assertOwnerMayResume(row: ModelRow): void {
  if (row.pausedBy === 'owner') return;
  if (row.pausedBy === 'admin') {
    throw new AppError('forbidden', { message: 'an admin paused this model' });
  }
  if (row.health.consecutiveFailures > 0) {
    throw new AppError('forbidden', {
      message: 'the model was paused by failed health checks; run a passing health check first',
    });
  }
}

function buildPatch(ctx: AppContext, row: ModelRow, patch: UpdateModelRequest) {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.imageUrl !== undefined) set.imageUrl = patch.imageUrl;
  const upstream = patch.upstream ?? {};
  // A new endpoint never receives the stored key: whoever moves it re-supplies one.
  if (
    upstream.baseUrl !== undefined &&
    upstream.baseUrl !== row.upstream.baseUrl &&
    upstream.apiKey === undefined
  ) {
    throw new AppError('invalid_request', {
      message: 'changing upstream.baseUrl requires upstream.apiKey',
    });
  }
  if (upstream.baseUrl !== undefined) set['upstream.baseUrl'] = upstream.baseUrl;
  if (upstream.modelName !== undefined) set['upstream.modelName'] = upstream.modelName;
  if (upstream.supportsStreamUsage !== undefined) {
    set['upstream.supportsStreamUsage'] = upstream.supportsStreamUsage;
  }
  if (upstream.apiKey !== undefined) {
    set['upstream.apiKeyEnc'] = encrypt(upstream.apiKey, ctx.env.MASTER_KEY);
  }
  const pricing = patch.pricing ?? {};
  if (pricing.inputPerMTokUsdc !== undefined) {
    set['pricing.inputPerMTokMicroUsdc'] = usdcStringToMicro(pricing.inputPerMTokUsdc);
  }
  if (pricing.outputPerMTokUsdc !== undefined) {
    set['pricing.outputPerMTokMicroUsdc'] = usdcStringToMicro(pricing.outputPerMTokUsdc);
  }
  if (patch.status !== undefined) {
    if (row.status === 'delisted') {
      throw new AppError('forbidden', { message: 'delisted models cannot be resumed' });
    }
    if (patch.status === 'paused' && row.status === 'active') {
      set.status = 'paused';
      set.pausedBy = 'owner';
    }
    if (patch.status === 'active' && row.status === 'paused') {
      assertOwnerMayResume(row);
      set.status = 'active';
      set.pausedBy = null;
      // Resuming clears the health-check strike count (L483).
      set['health.consecutiveFailures'] = 0;
    }
  }
  return set;
}

export async function updateModel(
  ctx: AppContext,
  userId: string,
  id: string,
  patch: UpdateModelRequest,
): Promise<OwnerModel> {
  const row = await Models.findById(id).lean<ModelRow>();
  if (!row) throw new AppError('model_not_found');
  if (!row.providerId.equals(userId)) throw new AppError('forbidden');

  const set = buildPatch(ctx, row, patch);
  // API-03: never write over a delist. A status change also requires the status and
  // pauser it was decided on, so a concurrent admin or health pause is never undone.
  const statusGuard =
    'status' in set
      ? {
          status: row.status,
          pausedBy: row.pausedBy ?? null,
          'health.consecutiveFailures': row.health.consecutiveFailures,
        }
      : {};
  const updated = await Models.findOneAndUpdate(
    { _id: row._id, providerId: row.providerId, status: { $ne: 'delisted' }, ...statusGuard },
    { $set: set },
    { new: true },
  ).lean<ModelRow>();
  if (!updated) {
    const current = await Models.findById(row._id).select({ status: 1 }).lean();
    if (!current) throw new AppError('model_not_found');
    if (current.status === 'delisted') {
      throw new AppError('forbidden', { message: 'the model was delisted' });
    }
    throw new AppError('invalid_request', { message: 'model status changed meanwhile; retry' });
  }
  if (row.status === 'active' && updated.status === 'paused') {
    ctx.alerts.modelPaused({ modelId: id, slug: updated.slug, reason: 'owner' });
  }
  return toOwnerDto(updated, await walletOf(updated));
}
