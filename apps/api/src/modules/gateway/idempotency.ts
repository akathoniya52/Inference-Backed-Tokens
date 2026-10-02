import { createHash } from 'node:crypto';

import { Idempotency, Types } from '@ibt/db';
import { AppError, GATEWAY_REQUEST_HEADERS } from '@ibt/shared';
import type { Request } from 'express';
import { z } from 'zod';

import { isDuplicateKey } from '../../lib/mongoErrors.js';

const MAX_KEY_LENGTH = 255;

const StoredResponseSchema = z.object({
  status: z.int(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

export type StoredResponse = z.infer<typeof StoredResponseSchema>;

export type IdempotencyClaim =
  { kind: 'claimed'; id: Types.ObjectId } | { kind: 'replay'; response: StoredResponse };

export function idempotencyKeyOf(req: Request): string | undefined {
  const key = req.get(GATEWAY_REQUEST_HEADERS.idempotencyKey);
  if (key === undefined) return undefined;
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new AppError('invalid_request', {
      message: `Idempotency-Key must be 1–${MAX_KEY_LENGTH} characters`,
    });
  }
  return key;
}

export function requestHash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/**
 * L148: the first request with a key inserts the row (`response: null` while
 * in flight); the unique `{userId, key}` index makes concurrent duplicates
 * collide. A completed key replays its stored response.
 */
export async function claimIdempotency(
  userId: string,
  key: string,
  hash: string,
): Promise<IdempotencyClaim> {
  const owner = new Types.ObjectId(userId);
  try {
    const row = await Idempotency.create({ userId: owner, key, requestHash: hash });
    return { kind: 'claimed', id: row._id };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
  const existing = await Idempotency.findOne({ userId: owner, key }).lean();
  if (!existing || existing.response === null) throw new AppError('idempotency_in_progress');
  if (existing.requestHash !== hash) {
    throw new AppError('invalid_request', {
      message: 'Idempotency-Key was already used with a different request body',
    });
  }
  return { kind: 'replay', response: StoredResponseSchema.parse(existing.response) };
}

export async function completeIdempotency(
  id: Types.ObjectId,
  response: StoredResponse,
): Promise<void> {
  await Idempotency.updateOne({ _id: id }, { $set: { response } });
}

/** Failed calls free the key so the client can retry it. */
export async function abandonIdempotency(id: Types.ObjectId): Promise<void> {
  await Idempotency.deleteOne({ _id: id });
}
