import type { ListModelsResponse, Model } from '@ibt/shared';

// Typed API fixtures shaped like `GET /api/models` (spec L391, P3-T5). Keys and
// signatures are random but valid base58 so they pass the shared schemas.

export const CURVE_MINT = '4h5YAMFmKhoGQSCvr3QRnWpdeZcDv33m29GxHyEozqHx';
export const CURVE_DBC_POOL = '6udkquQQhWPr9UEjT7cCki3bZiiEfbQyrXJJHy6uH7zS';
export const GRADUATED_MINT = 'Auy8EKRNeNaD7oWYL6h1tj33w32m7djsQe7yCQoWuWt4';
export const GRADUATED_DBC_POOL = '5iC4xzEnwq98oawxp8XsxBkEhnqrizXLxheNELvtUgL4';
export const GRADUATED_DAMM_POOL = 'BuY3BvARFp7Ti38Us8zVfC7R6ouRcL2msubxuR2Gcpa';
export const GRADUATED_MIGRATION_SIG =
  '8xnnEm5G4be1dhzYMF3otkFJkBmiT2shXCkaBcRfKqhzjBrptsEEDVZ9KvZsfMvQbN5KAM4jJGfSYHU898cVUEs';
const PROVIDER_A = 'AG9cCskMuNW22BfsKVWNUeRwjCDvTTMxrG7WtchWyvbc';
const PROVIDER_B = '4L6J1SYPsUWYofLEPqW7rEbMUBmLdkzXQjF29H2nW7gV';

const DEFAULT_SPLITS = { providerBps: 7000, liquidityBps: 2000, platformBps: 1000 };
const NO_TOKEN = {
  status: 'none',
  symbol: null,
  mint: null,
  dbcPool: null,
  dammV2Pool: null,
  launchSignature: null,
  migrationSignature: null,
  keeperPosition: null,
} as const satisfies Model['token'];

export const curveModel: Model = {
  id: '9718fadb6261dda3a2c48a7c',
  slug: 'llama-3.1-8b-fast',
  name: 'Llama 3.1 8B Fast',
  description: 'Low-latency 8B instruct model served on dedicated H100s.',
  imageUrl: null,
  providerWallet: PROVIDER_A,
  status: 'active',
  pricing: { inputPerMTokUsdc: '0.200000', outputPerMTokUsdc: '0.600000' },
  splits: DEFAULT_SPLITS,
  health: { lastOkAt: '2026-10-02T13:59:00.000Z', p50LatencyMs: 420, consecutiveFailures: 0 },
  token: {
    status: 'curve',
    symbol: 'LLAMA8',
    mint: CURVE_MINT,
    dbcPool: CURVE_DBC_POOL,
    dammV2Pool: null,
    launchSignature:
      '3kvDZW11xwRTN4E7zzoxMbVjsDzoswpU8nRmD1QfotgZSvmBgXfEW8mcic7mkVt3UFqBByzGxtAdjZDTGzoRzVkP',
    migrationSignature: null,
    keeperPosition: null,
  },
  stats: { requests24h: 1180, successRate: 0.992, revenueUsdc24h: '14.30' },
  createdAt: '2026-09-28T10:00:00.000Z',
};

export const graduatedModel: Model = {
  id: '2b8d1be1cb4505bd4575edfc',
  slug: 'qwen-2.5-coder-32b',
  name: 'Qwen 2.5 Coder 32B',
  description: 'Code completion and repair, 32k context.',
  imageUrl: null,
  providerWallet: PROVIDER_B,
  status: 'active',
  pricing: { inputPerMTokUsdc: '0.900000', outputPerMTokUsdc: '1.250000' },
  splits: DEFAULT_SPLITS,
  health: { lastOkAt: '2026-10-02T13:59:30.000Z', p50LatencyMs: 910, consecutiveFailures: 0 },
  token: {
    status: 'graduated',
    symbol: 'QCODE',
    mint: GRADUATED_MINT,
    dbcPool: GRADUATED_DBC_POOL,
    dammV2Pool: GRADUATED_DAMM_POOL,
    launchSignature:
      '3Qz2myw1p9vmGTNpJAz4Bx2u9Uze5yLFYgmvAmp2bLUg3BENJ2v2Um9AvV92anGzrYvtEfMEXNcor4cr3xC76dqz',
    migrationSignature: GRADUATED_MIGRATION_SIG,
    keeperPosition: '79opzr775d47nVxEpgQfe531hDWoQZ75FFdk2Lh4U4aD',
  },
  stats: {
    requests24h: 48211,
    successRate: 0.9987,
    revenueUsdc24h: '312.448120',
    lockedLiquiditySol: '3.215',
  },
  createdAt: '2026-09-20T08:30:00.000Z',
};

export const unlaunchedModel: Model = {
  id: '9faaa90243ffb0a30e38644a',
  slug: 'mistral-small-24b',
  name: 'Mistral Small 24B',
  description: 'General-purpose instruct model with function calling.',
  imageUrl: null,
  providerWallet: PROVIDER_A,
  status: 'active',
  pricing: { inputPerMTokUsdc: '0.100000', outputPerMTokUsdc: '0.300000' },
  splits: DEFAULT_SPLITS,
  health: { lastOkAt: null, p50LatencyMs: null, consecutiveFailures: 0 },
  token: NO_TOKEN,
  stats: { requests24h: 0, successRate: 0, revenueUsdc24h: '0' },
  createdAt: '2026-10-01T16:45:00.000Z',
};

export const modelsPage1: ListModelsResponse = {
  items: [curveModel, graduatedModel],
  nextCursor: 'cursor-page-2',
};

export const modelsPage2: ListModelsResponse = {
  items: [unlaunchedModel],
  nextCursor: null,
};

export const emptyModels: ListModelsResponse = { items: [], nextCursor: null };
