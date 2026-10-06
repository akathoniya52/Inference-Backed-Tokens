import { createHash } from 'node:crypto';

import {
  claimIdempotencyRow,
  completeIdempotencyRow,
  releaseIdempotencyRow,
  type IdempotencyLock,
} from '@ibt/db';
import { AppError, GATEWAY_REQUEST_HEADERS } from '@ibt/shared';
import type { Request } from 'express';
import { z } from 'zod';

const MAX_KEY_LENGTH = 255;

/**
 * GW-06: how long a claim stays locked past the longest gateway call, so a
 * claim whose process died is taken over by the next retry instead of
 * answering 409 for the 24 h TTL.
 */
export const IDEMPOTENCY_LOCK_MARGIN_MS = 5 * 60 * 1000;

const StoredResponseSchema = z.object({
  status: z.int(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

export type StoredResponse = z.infer<typeof StoredResponseSchema>;

export type IdempotencyClaim =
  { kind: 'claimed'; lock: IdempotencyLock } | { kind: 'replay'; response: StoredResponse };

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

/** JSON with object keys sorted at every depth; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const fields = Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** GW-11: the same request with its keys in another order hashes the same. */
export function requestHash(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/**
 * L148: the first request with a key claims the row under a lock that outlives
 * the call (GW-06); concurrent duplicates get 409 while it is held. A completed
 * key replays its stored response; the same key with another body is a 400.
 */
export async function claimIdempotency(
  userId: string,
  key: string,
  hash: string,
  { lockMs, now }: { lockMs: number; now: Date },
): Promise<IdempotencyClaim> {
  const claim = await claimIdempotencyRow(userId, key, hash, { lockMs, now });
  if (claim.kind === 'claimed') {
    return { kind: 'claimed', lock: { id: claim.id, lockedUntil: claim.lockedUntil } };
  }
  if (claim.kind === 'in_progress') throw new AppError('idempotency_in_progress');
  if (claim.requestHash !== hash) {
    throw new AppError('invalid_request', {
      message: 'Idempotency-Key was already used with a different request body',
    });
  }
  return { kind: 'replay', response: StoredResponseSchema.parse(claim.response) };
}

/** Stores the response; false when the lock expired and another request took the key over. */
export async function completeIdempotency(
  lock: IdempotencyLock,
  response: StoredResponse,
): Promise<boolean> {
  return completeIdempotencyRow(lock, response);
}

/** Frees the key for a retry; only for calls that were never billed (GW-05). */
export async function releaseIdempotency(lock: IdempotencyLock): Promise<void> {
  await releaseIdempotencyRow(lock);
}

/**
 * GW-05: the terminal record of a call that was billed but cannot be replayed
 * (its stream ended early): a retry with the key gets this instead of a second
 * charge.
 */
export function notReplayable(
  headers: Record<string, string>,
  requestId: string | undefined,
): StoredResponse {
  const error = new AppError('invalid_request', {
    message:
      'the call with this Idempotency-Key was billed but ended early and cannot be replayed; use a new key',
  });
  return {
    status: error.httpStatus,
    headers,
    body: JSON.stringify(error.toEnvelope(requestId)),
  };
}
