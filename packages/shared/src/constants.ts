// Addresses, limits and defaults shared by api, keeper and web.
// Money is integer micro-USDC (bigint); on-chain amounts are base units.

export const CLUSTERS = ['devnet', 'mainnet-beta'] as const;
export type Cluster = (typeof CLUSTERS)[number];

// Meteora programs and accounts (Plan.md L129–134, L655–663); same on both clusters.
export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
export const DBC_POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
export const DAMM_V2_PROGRAM_ID = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
/** DAMM v2 migration fee config, option 2 (100 bps). */
export const DAMM_V2_FEE_CONFIG = 'Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** Meteora's mainnet migration keepers, the fallback crank (L124). */
export const METEORA_MIGRATION_KEEPERS = Object.freeze([
  'Asi5DTGEeiso6k7ya6ndDabEZ7DRCgfTpCBLPH5E3aQs',
  'DeQ8dPv6ReZNQ45NfiWwS5CchWpB2BVq1QMyNV8L2uSW',
] as const);

export const USDC_MINT: Readonly<Record<Cluster, string>> = Object.freeze({
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
});

/** Curve quote threshold per cluster, in whole SOL (A5). */
export const MIGRATION_THRESHOLD_SOL: Readonly<Record<Cluster, number>> = Object.freeze({
  devnet: 1,
  'mainnet-beta': 10,
});

export interface ClusterConfig {
  readonly cluster: Cluster;
  readonly usdcMint: string;
  readonly migrationThresholdSol: number;
}

export const CLUSTER_CONFIG: Readonly<Record<Cluster, ClusterConfig>> = Object.freeze({
  devnet: Object.freeze({
    cluster: 'devnet',
    usdcMint: USDC_MINT.devnet,
    migrationThresholdSol: MIGRATION_THRESHOLD_SOL.devnet,
  }),
  'mainnet-beta': Object.freeze({
    cluster: 'mainnet-beta',
    usdcMint: USDC_MINT['mainnet-beta'],
    migrationThresholdSol: MIGRATION_THRESHOLD_SOL['mainnet-beta'],
  }),
});

export const USDC_DECIMALS = 6;
export const MICRO_PER_USDC = 1_000_000n;
export const SOL_DECIMALS = 9;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Model tokens are minted with 6 decimals (`TokenDecimal.SIX`). */
export const TOKEN_DECIMALS = 6;
/** Prices are quoted per million tokens. */
export const TOKENS_PER_MTOK = 1_000_000n;

// Revenue split (A4, L152–160).
export const BPS_DENOMINATOR = 10_000;

export interface SplitsBps {
  readonly providerBps: number;
  readonly liquidityBps: number;
  readonly platformBps: number;
}

export const DEFAULT_SPLITS_BPS: SplitsBps = Object.freeze({
  providerBps: 7000,
  liquidityBps: 2000,
  platformBps: 1000,
});

// Holder discount (L186): 1,000,000 whole tokens → 10% off.
export const HOLDER_MIN_BASE_UNITS = 1_000_000n * 10n ** BigInt(TOKEN_DECIMALS);
export const HOLDER_DISCOUNT_BPS = 1000;
export const HOLDER_BALANCE_CACHE_MS = 5 * 60 * 1000;

// Gateway limits (L236–238, L517, L522).
export const RATE_LIMIT_PER_MIN = 60;
export const MAX_TOKENS_CAP = 8192;
export const DEFAULT_MAX_TOKENS = 1024;
export const FIRST_BYTE_TIMEOUT_MS = 30_000;
export const TOTAL_TIMEOUT_MS = 300_000;
export const BODY_LIMIT_BYTES = 1024 * 1024;
export const DAILY_CAP_DEFAULT_MICRO = 50_000_000n;
// Prompt size before tiktoken runs: characters of every counted string, in
// total and per string (media part payloads are not counted).
export const MAX_PROMPT_CHARS = 256 * 1024;
export const MAX_PROMPT_STRING_CHARS = 64 * 1024;
// Hold surcharge per non-text content part; tiktoken cannot size these.
export const IMAGE_PART_HOLD_TOKENS = 2_048;
export const AUDIO_PART_HOLD_TOKENS = 8_192;
export const FILE_PART_HOLD_TOKENS = 8_192;

// Lifetimes (L223, L148, L520, G13, G15).
export const HOLD_TTL_MS = 600_000;
export const NONCE_TTL_MS = 300_000;
export const JWT_TTL_S = 86_400;
export const JWT_ISSUER = 'ibt-api';
export const JWT_AUDIENCE = 'ibt-web';
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

// Settlement (L176) and health checks (L250).
export const MIN_PAYOUT_MICRO = 1_000_000n;
export const HEALTH_FAILURES_TO_PAUSE = 3;

// API keys and deposits (L224, L273, L283).
export const API_KEY_PREFIX = 'ibt_';
export const API_KEY_DISPLAY_PREFIX_LENGTH = 12;
export const DEPOSIT_REF_LENGTH = 8;

// Pagination (L457).
export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 20;
