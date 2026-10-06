import { z } from 'zod';

import { TOKEN_PHASES } from '../split.js';
import {
  BaseUnitsSchema,
  DecimalStringSchema,
  IsoDateTimeSchema,
  MAX_U64,
  ObjectIdSchema,
  PaginationQuerySchema,
  PublicKeySchema,
  TxSignatureSchema,
  UsdcAmountSchema,
  paginated,
} from './common.js';
import { ModelStatsSchema, TokenStatusSchema, TokenSymbolSchema } from './models.js';

export const TokenPhaseSchema = z.enum(TOKEN_PHASES);
export const MintParamsSchema = z.object({ mint: PublicKeySchema });

export const LaunchPrepareRequestSchema = z.object({
  modelId: ObjectIdSchema,
  mint: PublicKeySchema,
  symbol: TokenSymbolSchema.optional(),
});
export const LaunchPrepareResponseSchema = z.object({
  token: z.object({ status: z.literal('pending'), mint: PublicKeySchema }),
  /** The token metadata URI confirm requires (API-06); absent when the api checks none. */
  metadataUri: z.url({ protocol: /^https?$/ }).optional(),
});

export const LaunchConfirmRequestSchema = z.object({
  modelId: ObjectIdSchema,
  mint: PublicKeySchema,
  signature: TxSignatureSchema,
});
export const LaunchConfirmResponseSchema = z.object({
  token: z.object({
    status: TokenStatusSchema,
    mint: PublicKeySchema,
    dbcPool: PublicKeySchema,
    progress: z.number().min(0).max(1),
  }),
});

export const TokenStateResponseSchema = z.object({
  phase: TokenPhaseSchema,
  progress: z.number().min(0).max(1),
  quoteReserveSol: DecimalStringSchema,
  priceSolPerToken: DecimalStringSchema,
  dbcPool: PublicKeySchema.nullable(),
  dammV2Pool: PublicKeySchema.nullable(),
  lockedLiquiditySol: DecimalStringSchema,
  stats: ModelStatsSchema,
});

export const QuoteQuerySchema = z.object({
  side: z.enum(['buy', 'sell']),
  /** Lamports when buying, token base units when selling; a `u64` on chain. */
  amount: z
    .string()
    .max(MAX_U64.toString().length, { message: 'amount is too large', abort: true })
    .regex(/^[1-9]\d*$/, { message: 'amount must be a positive integer string', abort: true })
    .refine((value) => BigInt(value) <= MAX_U64, { message: 'amount is too large' }),
});
export const QuoteResponseSchema = z.object({
  side: z.enum(['buy', 'sell']),
  phase: z.enum(['curve', 'graduated']),
  amountIn: BaseUnitsSchema,
  amountOut: BaseUnitsSchema,
  fee: BaseUnitsSchema,
  priceImpactPct: z.number().min(0).nullable(),
});

export const SettlementStateSchema = z.enum([
  'computing',
  'paid_provider',
  'converted',
  'bought',
  'locked',
  'done',
  'failed',
]);

const SignatureOrNull = TxSignatureSchema.nullable();

export const SettlementSchema = z.object({
  id: ObjectIdSchema,
  modelId: ObjectIdSchema,
  periodStart: IsoDateTimeSchema,
  periodEnd: IsoDateTimeSchema,
  state: SettlementStateSchema,
  revenueUsdc: UsdcAmountSchema,
  requestCount: z.int().min(0),
  provider: z.object({
    amountUsdc: UsdcAmountSchema,
    carryOverUsdc: UsdcAmountSchema,
    txSignature: SignatureOrNull,
  }),
  liquidity: z.object({
    phase: TokenPhaseSchema,
    sliceUsdc: UsdcAmountSchema,
    solLamports: BaseUnitsSchema.nullable(),
    solPriceUsdc: DecimalStringSchema.nullable(),
    tokensBaseUnits: BaseUnitsSchema.nullable(),
    buyTxSignature: SignatureOrNull,
    swapTxSignature: SignatureOrNull,
    migrationSignature: SignatureOrNull,
    addTxSignature: SignatureOrNull,
    lockTxSignature: SignatureOrNull,
    claimTxSignature: SignatureOrNull,
  }),
  platformUsdc: UsdcAmountSchema,
  updatedAt: IsoDateTimeSchema,
});

export const SettlementsQuerySchema = PaginationQuerySchema;
export const SettlementsResponseSchema = paginated(SettlementSchema);

export const MAX_SNAPSHOT_LIMIT = 1000;
/** 288 polls ≈ 72 minutes at the keeper's 15 s poll rate. */
export const DEFAULT_SNAPSHOT_LIMIT = 288;

export const TokenSnapshotsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_SNAPSHOT_LIMIT).default(DEFAULT_SNAPSHOT_LIMIT),
});
/** One pool snapshot reduced to what the price chart needs (L358–368). */
export const PricePointSchema = z.object({
  ts: IsoDateTimeSchema,
  priceSolPerToken: DecimalStringSchema,
  progress: z.number().min(0).max(1),
  phase: z.enum(['curve', 'graduated']),
});
/** `GET /api/tokens/:mint/snapshots`: the most recent points, oldest first. */
export const TokenSnapshotsResponseSchema = z.object({
  mint: PublicKeySchema,
  points: z.array(PricePointSchema),
});

/** Metaplex-style JSON served at `/metadata/:mint.json` (L229). */
export const TokenMetadataSchema = z.object({
  name: z.string(),
  symbol: z.string(),
  description: z.string(),
  image: z.string(),
  external_url: z.string(),
  attributes: z.array(z.object({ trait_type: z.string(), value: z.string() })),
});

export type LaunchPrepareRequest = z.infer<typeof LaunchPrepareRequestSchema>;
export type LaunchPrepareResponse = z.infer<typeof LaunchPrepareResponseSchema>;
export type LaunchConfirmRequest = z.infer<typeof LaunchConfirmRequestSchema>;
export type LaunchConfirmResponse = z.infer<typeof LaunchConfirmResponseSchema>;
export type TokenStateResponse = z.infer<typeof TokenStateResponseSchema>;
export type QuoteQuery = z.infer<typeof QuoteQuerySchema>;
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;
export type SettlementState = z.infer<typeof SettlementStateSchema>;
export type Settlement = z.infer<typeof SettlementSchema>;
export type SettlementsResponse = z.infer<typeof SettlementsResponseSchema>;
export type TokenSnapshotsQuery = z.infer<typeof TokenSnapshotsQuerySchema>;
export type PricePoint = z.infer<typeof PricePointSchema>;
export type TokenSnapshotsResponse = z.infer<typeof TokenSnapshotsResponseSchema>;
export type TokenMetadata = z.infer<typeof TokenMetadataSchema>;
