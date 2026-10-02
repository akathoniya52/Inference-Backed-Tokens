import { ApiKeys, Types, Users, type ApiKeyFields } from '@ibt/db';
import {
  AppError,
  DAILY_CAP_DEFAULT_MICRO,
  microToUsdcString,
  usdcStringToMicro,
  type ApiKey,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  type ListApiKeysResponse,
  type PaginationQuery,
} from '@ibt/shared';
import { generateApiKey, keyPrefix, sha256Hex } from '@ibt/shared/node';

import type { AppContext } from '../../app.js';
import type { ApiKeyContext } from '../../context.js';
import { cursorFilter, toPage } from '../../pagination.js';

/** `lastUsedAt` is written at most once per window per key. */
export const LAST_USED_THROTTLE_MS = 60_000;

type ApiKeyRow = ApiKeyFields & { _id: Types.ObjectId; createdAt: Date };

function toDto(row: ApiKeyRow): ApiKey {
  return {
    id: row._id.toHexString(),
    name: row.name,
    prefix: row.prefix,
    status: row.status,
    dailyCapUsdc: microToUsdcString(row.dailyCapMicroUsdc),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function defaultDailyCap(ctx: AppContext): bigint {
  return ctx.env.DAILY_CAP_USDC === undefined
    ? DAILY_CAP_DEFAULT_MICRO
    : usdcStringToMicro(ctx.env.DAILY_CAP_USDC);
}

export async function createKey(
  ctx: AppContext,
  userId: string,
  input: CreateApiKeyRequest,
): Promise<CreateApiKeyResponse> {
  const key = generateApiKey();
  const doc = await ApiKeys.create({
    userId: new Types.ObjectId(userId),
    keyHash: sha256Hex(key),
    prefix: keyPrefix(key),
    name: input.name,
    dailyCapMicroUsdc:
      input.dailyCapUsdc === undefined
        ? defaultDailyCap(ctx)
        : usdcStringToMicro(input.dailyCapUsdc),
  });
  return { ...toDto(doc.toObject()), key };
}

export async function listKeys(
  userId: string,
  query: PaginationQuery,
): Promise<ListApiKeysResponse> {
  const rows = await ApiKeys.find({
    userId: new Types.ObjectId(userId),
    ...cursorFilter(query.cursor),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean<ApiKeyRow[]>();
  const page = toPage(rows, query.limit);
  return { items: page.rows.map(toDto), nextCursor: page.nextCursor };
}

export async function revokeKey(userId: string, id: string): Promise<ApiKey> {
  const row = await ApiKeys.findOneAndUpdate(
    { _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) },
    { $set: { status: 'revoked' } },
    { new: true },
  ).lean<ApiKeyRow>();
  if (!row) throw new AppError('not_found', { message: 'API key not found' });
  return toDto(row);
}

/** Resolves a bearer API key (L234 step 1): unknown, revoked or orphaned → 401. */
export async function authenticateKey(ctx: AppContext, key: string): Promise<ApiKeyContext> {
  const row = await ApiKeys.findOne({ keyHash: sha256Hex(key) }).lean<ApiKeyRow>();
  if (!row || row.status !== 'active') throw new AppError('invalid_api_key');
  const user = await Users.findById(row.userId).select({ wallet: 1 }).lean();
  if (!user) throw new AppError('invalid_api_key');

  const now = ctx.clock();
  const staleBefore = new Date(now.getTime() - LAST_USED_THROTTLE_MS);
  await ApiKeys.updateOne(
    { _id: row._id, $or: [{ lastUsedAt: null }, { lastUsedAt: { $lt: staleBefore } }] },
    { $set: { lastUsedAt: now } },
  );
  return {
    apiKeyId: row._id.toHexString(),
    userId: row.userId.toHexString(),
    wallet: user.wallet,
    dailyCapMicroUsdc: row.dailyCapMicroUsdc,
  };
}
