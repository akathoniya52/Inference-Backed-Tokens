import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

export const REQUEST_STATUSES = ['success', 'upstream_error', 'timeout', 'client_abort'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const REQUEST_TTL_S = 90 * 24 * 60 * 60;

const requestSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    apiKeyId: { type: Schema.Types.ObjectId, ref: 'ApiKey', required: true },
    modelId: { type: Schema.Types.ObjectId, ref: 'Model', required: true },
    requestId: { type: String, required: true },
    idempotencyKey: { type: String },
    status: { type: String, enum: REQUEST_STATUSES, required: true },
    promptTokens: { type: Number, required: true, default: 0 },
    completionTokens: { type: Number, required: true, default: 0 },
    usageEstimated: { type: Boolean, required: true, default: false },
    costMicroUsdc: { type: BigInt, required: true, default: 0n },
    discountBps: { type: Number, required: true, default: 0 },
    latencyMs: { type: Number, required: true, default: 0 },
    streamed: { type: Boolean, required: true, default: false },
    upstreamStatus: { type: Number, default: null },
    settlementId: { type: Schema.Types.ObjectId, ref: 'Settlement', default: null },
    /** UTC day whose `dailySpend` row the hold reserved against; `null` for uncapped holds. */
    dailyCapDay: { type: Date, default: null },
  },
  { collection: 'requests', timestamps: { createdAt: true, updatedAt: false }, autoIndex: false },
);

requestSchema.index({ requestId: 1 }, { unique: true });
/**
 * TTL (KPR-09): only rows no settlement still needs expire, i.e. settled ones and unbilled
 * ones (cost 0, never tagged). A billed request is kept until a settlement tags it. Named
 * apart from the old unfiltered `createdAt_1` TTL, which `createAllIndexes()` drops as a
 * legacy index and `syncIndexes()` drops as undeclared.
 */
requestSchema.index(
  { createdAt: 1 },
  {
    name: 'createdAt_ttl_settled',
    expireAfterSeconds: REQUEST_TTL_S,
    partialFilterExpression: { settlementId: { $type: 'objectId' } },
  },
);
requestSchema.index(
  { createdAt: 1 },
  {
    name: 'createdAt_ttl_unbilled',
    expireAfterSeconds: REQUEST_TTL_S,
    partialFilterExpression: { costMicroUsdc: { $lte: 0 } },
  },
);
requestSchema.index({ modelId: 1, settlementId: 1, createdAt: 1 });
requestSchema.index({ userId: 1, createdAt: 1 });
requestSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

export type RequestFields = InferSchemaType<typeof requestSchema>;
export type RequestDoc = HydratedDocument<RequestFields>;
export const Requests = model('Request', requestSchema);
