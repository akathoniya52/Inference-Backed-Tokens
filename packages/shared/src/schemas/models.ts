import { z } from 'zod';

import {
  DecimalStringSchema,
  IsoDateTimeSchema,
  ObjectIdSchema,
  PublicKeySchema,
  SplitsSchema,
  TxSignatureSchema,
  UsdcAmountSchema,
  UsdcInputSchema,
  paginated,
} from './common.js';

export const ModelSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, 'slug must be 2–64 chars of a-z, 0-9, ".", "_" or "-"');
export const ModelStatusSchema = z.enum(['active', 'paused', 'delisted']);
/** `pending` is set by `/launch/prepare` before the wallet signs (P5-T1). */
export const TokenStatusSchema = z.enum(['none', 'pending', 'curve', 'graduated']);
export const TokenSymbolSchema = z.string().regex(/^[A-Z0-9]{1,10}$/, 'symbol must be A-Z/0-9');

const ImageUrlSchema = z.url({ protocol: /^https$/ });

/**
 * An upstream base URL: http(s) with no credentials, query or fragment, so
 * `chatCompletionsUrl` can append a path and nothing rides along with it.
 */
const UpstreamBaseUrlSchema = z.url({ protocol: /^https?$/ }).refine(
  (value) => {
    // Unparseable values already fail the url check above.
    if (!URL.canParse(value)) return true;
    const url = new URL(value);
    return url.username === '' && url.password === '' && !/[?#]/.test(value);
  },
  { message: 'baseUrl must not contain credentials, a query or a fragment' },
);

export const PricingSchema = z.object({
  inputPerMTokUsdc: UsdcAmountSchema,
  outputPerMTokUsdc: UsdcAmountSchema,
});
export const PricingInputSchema = z.object({
  inputPerMTokUsdc: UsdcInputSchema,
  outputPerMTokUsdc: UsdcInputSchema,
});

export const ModelHealthSchema = z.object({
  lastOkAt: IsoDateTimeSchema.nullable(),
  p50LatencyMs: z.number().min(0).nullable(),
  consecutiveFailures: z.int().min(0),
});

export const ModelStatsSchema = z.object({
  requests24h: z.int().min(0),
  successRate: z.number().min(0).max(1),
  revenueUsdc24h: DecimalStringSchema,
  lockedLiquiditySol: DecimalStringSchema.optional(),
});

export const ModelTokenSchema = z.object({
  status: TokenStatusSchema,
  symbol: TokenSymbolSchema.nullable(),
  mint: PublicKeySchema.nullable(),
  dbcPool: PublicKeySchema.nullable(),
  dammV2Pool: PublicKeySchema.nullable(),
  launchSignature: TxSignatureSchema.nullable(),
  migrationSignature: TxSignatureSchema.nullable(),
  keeperPosition: PublicKeySchema.nullable(),
});

/**
 * Public model view. A plain (stripping) object, so `upstream.apiKeyEnc` or
 * any other stored secret can never survive serialization through it (L225).
 */
export const ModelSchema = z.object({
  id: ObjectIdSchema,
  slug: ModelSlugSchema,
  name: z.string(),
  description: z.string(),
  imageUrl: z.string().nullable(),
  providerWallet: PublicKeySchema,
  status: ModelStatusSchema,
  pricing: PricingSchema,
  splits: SplitsSchema,
  health: ModelHealthSchema,
  token: ModelTokenSchema,
  stats: ModelStatsSchema,
  createdAt: IsoDateTimeSchema,
});

/** Owner view: adds the upstream endpoint, never the key. */
export const OwnerModelSchema = ModelSchema.extend({
  upstream: z.object({
    baseUrl: z.string(),
    modelName: z.string(),
    supportsStreamUsage: z.boolean(),
  }),
});

export const CreateModelRequestSchema = z.object({
  slug: ModelSlugSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).default(''),
  imageUrl: ImageUrlSchema.optional(),
  upstream: z.object({
    baseUrl: UpstreamBaseUrlSchema,
    modelName: z.string().min(1).max(128),
    apiKey: z.string().min(1).max(512),
    supportsStreamUsage: z.boolean().default(false),
  }),
  pricing: PricingInputSchema,
});

export const UpdateModelRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(2000),
    imageUrl: ImageUrlSchema.nullable(),
    upstream: z
      .object({
        baseUrl: UpstreamBaseUrlSchema,
        modelName: z.string().min(1).max(128),
        apiKey: z.string().min(1).max(512),
        supportsStreamUsage: z.boolean(),
      })
      .partial(),
    pricing: PricingInputSchema.partial(),
    status: z.enum(['active', 'paused']),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'empty patch' });

export const ModelSlugParamsSchema = z.object({ slug: ModelSlugSchema });

export const ListModelsResponseSchema = paginated(ModelSchema);

export const HealthCheckResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().min(0).nullable(),
  status: ModelStatusSchema,
  consecutiveFailures: z.int().min(0),
  error: z.string().optional(),
});

export type ModelStatus = z.infer<typeof ModelStatusSchema>;
export type TokenStatus = z.infer<typeof TokenStatusSchema>;
export type Pricing = z.infer<typeof PricingSchema>;
export type ModelHealth = z.infer<typeof ModelHealthSchema>;
export type ModelStats = z.infer<typeof ModelStatsSchema>;
export type ModelToken = z.infer<typeof ModelTokenSchema>;
export type Model = z.infer<typeof ModelSchema>;
export type OwnerModel = z.infer<typeof OwnerModelSchema>;
export type CreateModelRequest = z.infer<typeof CreateModelRequestSchema>;
export type UpdateModelRequest = z.infer<typeof UpdateModelRequestSchema>;
export type ListModelsResponse = z.infer<typeof ListModelsResponseSchema>;
export type HealthCheckResponse = z.infer<typeof HealthCheckResponseSchema>;
