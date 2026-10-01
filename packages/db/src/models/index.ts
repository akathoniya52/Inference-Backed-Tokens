import { ApiKeys } from './apiKeys.js';
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
] as const);

/** Creates every collection and index (schemas use `autoIndex: false`, G11). */
export async function syncAllIndexes(): Promise<void> {
  for (const model of ALL_MODELS) {
    await model.createCollection();
    await model.syncIndexes();
  }
}
