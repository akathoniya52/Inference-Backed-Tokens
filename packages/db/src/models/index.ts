import { ApiKeys } from './apiKeys.js';
import { DailySpend } from './dailySpend.js';
import { Deposits } from './deposits.js';
import { Idempotency } from './idempotency.js';
import { Leases } from './leases.js';
import { Ledger } from './ledger.js';
import { Models } from './models.js';
import { Nonces } from './nonces.js';
import { PoolSnapshots } from './poolSnapshots.js';
import { Requests } from './requests.js';
import { Settlements } from './settlements.js';
import { Users } from './users.js';

export * from './apiKeys.js';
export * from './dailySpend.js';
export * from './deposits.js';
export * from './idempotency.js';
export * from './leases.js';
export * from './ledger.js';
export * from './models.js';
export * from './nonces.js';
export * from './poolSnapshots.js';
export * from './requests.js';
export * from './settlements.js';
export * from './users.js';

export const ALL_MODELS = Object.freeze([
  Users,
  ApiKeys,
  Models,
  Requests,
  Ledger,
  Deposits,
  Settlements,
  PoolSnapshots,
  Nonces,
  Idempotency,
  Leases,
  DailySpend,
] as const);

/**
 * Indexes a past schema declared that must not survive an upgrade. The unfiltered
 * `requests.createdAt_1` TTL deleted billed requests before settlement tagged them
 * (KPR-09); it was replaced by the partial `createdAt_ttl_*` indexes.
 */
const LEGACY_INDEXES = Object.freeze([{ model: Requests, name: 'createdAt_1' }] as const);

const INDEX_NOT_FOUND = 27;
const NAMESPACE_NOT_FOUND = 26;

async function dropLegacyIndexes(): Promise<void> {
  for (const { model, name } of LEGACY_INDEXES) {
    try {
      await model.collection.dropIndex(name);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== INDEX_NOT_FOUND && code !== NAMESPACE_NOT_FOUND) throw err;
    }
  }
}

/**
 * Boot-time index setup (API-14): creates every collection and every declared
 * index that is missing, and drops only the named `LEGACY_INDEXES`. Safe to run
 * from several processes at once; any other index whose options changed still
 * needs `syncAllIndexes` as an operator migration step.
 */
export async function createAllIndexes(): Promise<void> {
  for (const model of ALL_MODELS) {
    await model.createCollection();
  }
  await dropLegacyIndexes();
  for (const model of ALL_MODELS) {
    await model.createIndexes();
  }
}

/**
 * Creates every collection and index and drops indexes the schemas no longer
 * declare (schemas use `autoIndex: false`, G11). A migration step, not a boot step.
 */
export async function syncAllIndexes(): Promise<void> {
  for (const model of ALL_MODELS) {
    await model.createCollection();
    await model.syncIndexes();
  }
}
