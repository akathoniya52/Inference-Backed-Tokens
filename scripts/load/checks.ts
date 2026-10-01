// Ledger invariants checked after the run (spec L591, G14): no balance or available balance
// below zero, at most one capture per request and per hold, no hold left open, and every
// balance equal to the sum of its balance-moving ledger rows.
import { setTimeout as sleep } from 'node:timers/promises';

import { BALANCE_LEDGER_TYPES, Ledger, Requests, Users } from '@ibt/db';

export interface LedgerChecks {
  users: number;
  negativeBalances: number;
  negativeAvailable: number;
  duplicateCaptures: number;
  openHolds: number;
  nonZeroHeld: number;
  balanceDrift: number;
  captures: number;
  successRequests: number;
  failedRequests: number;
}

async function countAgg(pipeline: Parameters<typeof Ledger.aggregate>[0]): Promise<number> {
  const [row] = await Ledger.aggregate<{ n: number }>([...pipeline, { $count: 'n' }]);
  return row?.n ?? 0;
}

/**
 * Requests autocannon dropped at the end of its window still finish server-side; waits until
 * no hold is open (or `timeoutMs` passes) so they are not reported as stuck.
 */
export async function waitForOpenHolds(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await Ledger.countDocuments({ type: 'hold', status: 'open' });
    if (open === 0 || Date.now() >= deadline) return open;
    await sleep(250);
  }
}

export async function checkLedger(): Promise<LedgerChecks> {
  const [
    users,
    negativeBalances,
    negativeAvailable,
    duplicateByRequest,
    duplicateByHold,
    openHolds,
    nonZeroHeld,
    balanceDrift,
    captures,
    successRequests,
    failedRequests,
  ] = await Promise.all([
    Users.countDocuments({}),
    Users.countDocuments({ balanceMicroUsdc: { $lt: 0n } }),
    Users.countDocuments({
      $expr: { $lt: [{ $subtract: ['$balanceMicroUsdc', '$heldMicroUsdc'] }, 0] },
    }),
    countAgg([
      { $match: { type: 'capture' } },
      { $group: { _id: '$ref.requestId', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]),
    countAgg([
      { $match: { type: 'capture' } },
      { $group: { _id: '$ref.holdId', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]),
    Ledger.countDocuments({ type: 'hold', status: 'open' }),
    Users.countDocuments({ heldMicroUsdc: { $ne: 0n } }),
    Users.aggregate<{ n: number }>([
      {
        $lookup: {
          from: Ledger.collection.collectionName,
          let: { uid: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$userId', '$$uid'] },
                type: { $in: [...BALANCE_LEDGER_TYPES] },
              },
            },
            { $group: { _id: null, total: { $sum: '$amountMicroUsdc' } } },
          ],
          as: 'ledger',
        },
      },
      {
        $match: {
          $expr: {
            $ne: ['$balanceMicroUsdc', { $ifNull: [{ $first: '$ledger.total' }, 0] }],
          },
        },
      },
      { $count: 'n' },
    ]).then(([row]) => row?.n ?? 0),
    Ledger.countDocuments({ type: 'capture' }),
    Requests.countDocuments({ status: 'success' }),
    Requests.countDocuments({ status: { $ne: 'success' } }),
  ]);

  return {
    users,
    negativeBalances,
    negativeAvailable,
    duplicateCaptures: duplicateByRequest + duplicateByHold,
    openHolds,
    nonZeroHeld,
    balanceDrift,
    captures,
    successRequests,
    failedRequests,
  };
}
