import type {
  PricePoint,
  Settlement,
  SettlementsResponse,
  TokenSnapshotsResponse,
  TokenStateResponse,
} from '@ibt/shared';

import {
  curveModel,
  CURVE_DBC_POOL,
  CURVE_MINT,
  GRADUATED_DAMM_POOL,
  GRADUATED_DBC_POOL,
  graduatedModel,
} from './models';

// Shapes of `GET /api/tokens/:mint/state` (spec L452–454) and
// `GET /api/tokens/:mint/settlements` (P5-T2).

export const curveTokenState: TokenStateResponse = {
  phase: 'curve',
  progress: 0.42,
  quoteReserveSol: '0.42',
  priceSolPerToken: '0.0000000061',
  dbcPool: CURVE_DBC_POOL,
  dammV2Pool: null,
  lockedLiquiditySol: '0',
  stats: curveModel.stats,
};

export const graduatedTokenState: TokenStateResponse = {
  phase: 'graduated',
  progress: 1,
  quoteReserveSol: '1',
  priceSolPerToken: '0.0000000214',
  dbcPool: GRADUATED_DBC_POOL,
  dammV2Pool: GRADUATED_DAMM_POOL,
  lockedLiquiditySol: '3.215',
  stats: graduatedModel.stats,
};

export const PAYOUT_SIG =
  '2f515Zm4w5BxYoZoFj9JXNKju1p4wS7Y71xCfdnJoR6i19bFSXS46eVQ3syN1pzizZKggYwGcBumo4g1WqLZT3rq';
export const BUY_SIG =
  '5jwWQT9ycFhBs8nDUWRcN5mYheNDhTkirKvr2R4LKUw7J89GpsyJ3TaYfhJnGccJixHCVqvYsZDEh9kmESRRDV2b';
export const LOCK_SIG =
  '2SEi8W2f5iTRASyx4BrLWVR3MzFoiTJ6WrY3hG2RcBc44gzgo4f8GxGh2iYr3snvywCrVyw4NmHma8u3xaEgCRTb';
export const ADD_SIG =
  '4zavFqex2z2dTFf9nwyt9Mh7BM6A6tNmqczu6FdDHWoseYHArgzCKAsHkcVFK2c9ZkAN1NYHDhuoHf24SQhSv8CC';

const NO_LIQUIDITY_TXS = {
  buyTxSignature: null,
  swapTxSignature: null,
  migrationSignature: null,
  addTxSignature: null,
  lockTxSignature: null,
  claimTxSignature: null,
} as const;

export const doneSettlement: Settlement = {
  id: '23d19151e30dba27c50a33c6',
  modelId: curveModel.id,
  periodStart: '2026-10-02T13:00:00.000Z',
  periodEnd: '2026-10-02T14:00:00.000Z',
  state: 'done',
  revenueUsdc: '14.300000',
  requestCount: 1180,
  provider: { amountUsdc: '10.010000', carryOverUsdc: '0.000000', txSignature: PAYOUT_SIG },
  liquidity: {
    ...NO_LIQUIDITY_TXS,
    phase: 'curve',
    sliceUsdc: '2.860000',
    solLamports: '19066666',
    solPriceUsdc: '150.00',
    tokensBaseUnits: '3125000000000',
    buyTxSignature: BUY_SIG,
  },
  platformUsdc: '1.430000',
  updatedAt: '2026-10-02T14:05:41.000Z',
};

export const carriedSettlement: Settlement = {
  id: '1b7d42a938e0af6f350c1a25',
  modelId: curveModel.id,
  periodStart: '2026-10-02T12:00:00.000Z',
  periodEnd: '2026-10-02T13:00:00.000Z',
  state: 'failed',
  revenueUsdc: '0.840000',
  requestCount: 61,
  provider: { amountUsdc: '0.000000', carryOverUsdc: '0.588000', txSignature: null },
  liquidity: {
    ...NO_LIQUIDITY_TXS,
    phase: 'curve',
    sliceUsdc: '0.168000',
    solLamports: null,
    solPriceUsdc: null,
    tokensBaseUnits: null,
  },
  platformUsdc: '0.084000',
  updatedAt: '2026-10-02T13:06:02.000Z',
};

export const graduatedSettlement: Settlement = {
  id: '9467cdc9f4f4b4f1433904c4',
  modelId: graduatedModel.id,
  periodStart: '2026-10-02T13:00:00.000Z',
  periodEnd: '2026-10-02T14:00:00.000Z',
  state: 'done',
  revenueUsdc: '18.200000',
  requestCount: 2004,
  provider: { amountUsdc: '12.740000', carryOverUsdc: '0.000000', txSignature: PAYOUT_SIG },
  liquidity: {
    ...NO_LIQUIDITY_TXS,
    phase: 'graduated',
    sliceUsdc: '3.640000',
    solLamports: '24266666',
    solPriceUsdc: '150.00',
    tokensBaseUnits: null,
    addTxSignature: ADD_SIG,
    lockTxSignature: LOCK_SIG,
  },
  platformUsdc: '1.820000',
  updatedAt: '2026-10-02T14:06:12.000Z',
};

export const curveSettlementsPage: SettlementsResponse = {
  items: [doneSettlement, carriedSettlement],
  nextCursor: null,
};

export const emptySettlements: SettlementsResponse = { items: [], nextCursor: null };

// Shape of `GET /api/tokens/:mint/snapshots` (P7-T10): one point per 15 s keeper poll.
const curvePoint = (ts: string, priceSolPerToken: string, progress: number): PricePoint => ({
  ts,
  priceSolPerToken,
  progress,
  phase: 'curve',
});

export const curveSnapshots: TokenSnapshotsResponse = {
  mint: CURVE_MINT,
  points: [
    curvePoint('2026-10-02T13:59:00.000Z', '0.0000000052', 0.36),
    curvePoint('2026-10-02T13:59:15.000Z', '0.0000000055', 0.38),
    curvePoint('2026-10-02T13:59:30.000Z', '0.0000000054', 0.37),
    curvePoint('2026-10-02T13:59:45.000Z', '0.0000000058', 0.4),
    curvePoint('2026-10-02T14:00:00.000Z', '0.0000000061', 0.42),
  ],
};
