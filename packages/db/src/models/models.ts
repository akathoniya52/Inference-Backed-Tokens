import { DEFAULT_SPLITS_BPS, ModelStatusSchema, TokenStatusSchema } from '@ibt/shared';
import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const upstreamSchema = new Schema(
  {
    baseUrl: { type: String, required: true },
    modelName: { type: String, required: true },
    apiKeyEnc: { type: String, required: true },
    supportsStreamUsage: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const pricingSchema = new Schema(
  {
    inputPerMTokMicroUsdc: { type: BigInt, required: true },
    outputPerMTokMicroUsdc: { type: BigInt, required: true },
  },
  { _id: false },
);

const splitsSchema = new Schema(
  {
    providerBps: { type: Number, required: true, default: DEFAULT_SPLITS_BPS.providerBps },
    liquidityBps: { type: Number, required: true, default: DEFAULT_SPLITS_BPS.liquidityBps },
    platformBps: { type: Number, required: true, default: DEFAULT_SPLITS_BPS.platformBps },
  },
  { _id: false },
);

const healthSchema = new Schema(
  {
    lastOkAt: { type: Date, default: null },
    p50LatencyMs: { type: Number, default: null },
    consecutiveFailures: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const tokenSchema = new Schema(
  {
    status: { type: String, enum: TokenStatusSchema.options, required: true, default: 'none' },
    symbol: { type: String, default: null },
    mint: { type: String, default: null },
    dbcPool: { type: String, default: null },
    dammV2Pool: { type: String, default: null },
    launchSignature: { type: String, default: null },
    migrationSignature: { type: String, default: null },
    keeperPosition: { type: String, default: null },
    escrowBaseUnits: { type: BigInt, required: true, default: 0n },
    carryOverMicroUsdc: { type: BigInt, required: true, default: 0n },
    sliceCarryOverMicroUsdc: { type: BigInt, required: true, default: 0n },
    pendingCompoundLamports: { type: BigInt, required: true, default: 0n },
  },
  { _id: false },
);

const statsSchema = new Schema(
  {
    requests: { type: Number, required: true, default: 0 },
    successRate: { type: Number, required: true, default: 0 },
    revenueMicroUsdc: { type: BigInt, required: true, default: 0n },
    lockedLiquidityLamports: { type: BigInt, required: true, default: 0n },
  },
  { _id: false },
);

const modelSchema = new Schema(
  {
    providerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    slug: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    imageUrl: { type: String, default: null },
    upstream: { type: upstreamSchema, required: true },
    pricing: { type: pricingSchema, required: true },
    splits: { type: splitsSchema, required: true, default: () => ({}) },
    status: { type: String, enum: ModelStatusSchema.options, required: true, default: 'active' },
    health: { type: healthSchema, required: true, default: () => ({}) },
    token: { type: tokenSchema, required: true, default: () => ({}) },
    stats: { type: statsSchema, required: true, default: () => ({}) },
  },
  { collection: 'models', timestamps: true, autoIndex: false },
);

modelSchema.index({ slug: 1 }, { unique: true });
modelSchema.index(
  { 'token.mint': 1 },
  { unique: true, partialFilterExpression: { 'token.mint': { $type: 'string' } } },
);
modelSchema.index({ providerId: 1 });

export type ModelFields = InferSchemaType<typeof modelSchema>;
export type ModelDoc = HydratedDocument<ModelFields>;
export const Models = model('Model', modelSchema);
