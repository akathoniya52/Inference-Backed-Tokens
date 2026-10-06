import { HoldStatusSchema, LedgerTypeSchema } from '@ibt/shared';
import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

import { REQUEST_STATUSES } from './requests.js';

const ledgerRefSchema = new Schema(
  {
    txSignature: { type: String },
    requestId: { type: String },
    holdId: { type: Schema.Types.ObjectId },
    settlementId: { type: Schema.Types.ObjectId },
  },
  { _id: false },
);

/** The `dailySpend` row a hold reserved against. */
const dailyCapRefSchema = new Schema(
  {
    apiKeyId: { type: Schema.Types.ObjectId, required: true },
    day: { type: Date, required: true },
  },
  { _id: false },
);

/** The request a due capture records (the fields of `RequestRecord`). */
const dueRequestSchema = new Schema(
  {
    requestId: { type: String, required: true },
    apiKeyId: { type: Schema.Types.ObjectId, required: true },
    modelId: { type: Schema.Types.ObjectId, required: true },
    status: { type: String, enum: REQUEST_STATUSES, required: true },
    idempotencyKey: { type: String },
    promptTokens: { type: Number, required: true },
    completionTokens: { type: Number, required: true },
    usageEstimated: { type: Boolean },
    discountBps: { type: Number },
    latencyMs: { type: Number, required: true },
    streamed: { type: Boolean, required: true },
    upstreamStatus: { type: Number, default: null },
  },
  { _id: false },
);

const ledgerSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: LedgerTypeSchema.options, required: true },
    /** Hold rows only (G15). */
    status: { type: String, enum: HoldStatusSchema.options },
    /** Signed from the user's point of view. */
    amountMicroUsdc: { type: BigInt, required: true },
    ref: { type: ledgerRefSchema, required: true, default: () => ({}) },
    reason: { type: String },
    balanceAfterMicroUsdc: { type: BigInt, default: null },
    expiresAt: { type: Date },
    /** Hold rows placed under a daily cap only. */
    dailyCap: { type: dailyCapRefSchema, default: undefined },
    /**
     * Open hold rows only (GW-12): the cost of a delivered call whose capture
     * failed. Hold expiry captures it instead of releasing the hold.
     */
    captureDueMicroUsdc: { type: BigInt, default: null },
    captureDueRequest: { type: dueRequestSchema, default: undefined },
  },
  { collection: 'ledger', timestamps: { createdAt: true, updatedAt: false }, autoIndex: false },
);

ledgerSchema.index({ userId: 1, createdAt: 1 });
ledgerSchema.index({ type: 1, status: 1, expiresAt: 1 });
// One hold per request id: concurrent requests with the same id cannot both hold.
ledgerSchema.index(
  { 'ref.requestId': 1 },
  { unique: true, partialFilterExpression: { type: 'hold', 'ref.requestId': { $type: 'string' } } },
);
// One capture per hold; also serves the capture lookup by `ref.holdId`.
ledgerSchema.index(
  { 'ref.holdId': 1 },
  { unique: true, partialFilterExpression: { type: 'capture' } },
);
// A deposit signature or a settlement credits at most once, even without the caller's guard.
ledgerSchema.index(
  { 'ref.txSignature': 1 },
  { unique: true, partialFilterExpression: { type: 'deposit' } },
);
ledgerSchema.index(
  { 'ref.settlementId': 1 },
  {
    unique: true,
    partialFilterExpression: { type: 'adjust', 'ref.settlementId': { $type: 'objectId' } },
  },
);

export type LedgerFields = InferSchemaType<typeof ledgerSchema>;
export type LedgerDoc = HydratedDocument<LedgerFields>;
export const Ledger = model('LedgerEntry', ledgerSchema);
