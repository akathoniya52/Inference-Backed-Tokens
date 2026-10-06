import { SettlementStateSchema, TOKEN_PHASES } from '@ibt/shared';
import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const pendingTxSchema = new Schema(
  {
    step: { type: String, required: true },
    signature: { type: String, required: true },
    lastValidBlockHeight: { type: Number, required: true },
  },
  { _id: false },
);

const providerSchema = new Schema(
  {
    amountMicroUsdc: { type: BigInt, required: true, default: 0n },
    carryOverMicroUsdc: { type: BigInt, required: true, default: 0n },
    txSignature: { type: String, default: null },
    /** Amount and carry-over are fixed and the model's carry-over consumed, before any send. */
    reserved: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const liquiditySchema = new Schema(
  {
    phase: { type: String, enum: TOKEN_PHASES, required: true, default: 'none' },
    sliceMicroUsdc: { type: BigInt, required: true, default: 0n },
    solLamports: { type: BigInt, default: null },
    solPriceUsdc: { type: String, default: null },
    /** When `convert` fixed `solPriceUsdc`; the keeper's SOL price guard orders by it (KPR-04). */
    pricedAt: { type: Date, default: null },
    buyTxSignature: { type: String, default: null },
    swapTxSignature: { type: String, default: null },
    migrationSignature: { type: String, default: null },
    tokensBaseUnits: { type: BigInt, default: null },
    addTxSignature: { type: String, default: null },
    lockTxSignature: { type: String, default: null },
    claimTxSignature: { type: String, default: null },
    solAddedLamports: { type: BigInt, default: null },
  },
  { _id: false },
);

const settlementSchema = new Schema(
  {
    modelId: { type: Schema.Types.ObjectId, ref: 'Model', required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    state: {
      type: String,
      enum: SettlementStateSchema.options,
      required: true,
      default: 'computing',
    },
    lastCompletedState: { type: String, enum: SettlementStateSchema.options, default: null },
    revenueMicroUsdc: { type: BigInt, required: true, default: 0n },
    requestCount: { type: Number, required: true, default: 0 },
    provider: { type: providerSchema, required: true, default: () => ({}) },
    liquidity: { type: liquiditySchema, required: true, default: () => ({}) },
    platformMicroUsdc: { type: BigInt, required: true, default: 0n },
    pendingTx: { type: pendingTxSchema, default: null },
    /** Lease epoch of the keeper driving this settlement; writes from older epochs are refused. */
    leaseEpoch: { type: Number, default: null },
    attempts: { type: Number, required: true, default: 0 },
    error: { type: String, default: null },
  },
  { collection: 'settlements', timestamps: true, autoIndex: false },
);

settlementSchema.index({ modelId: 1, periodStart: 1 }, { unique: true });
settlementSchema.index({ state: 1, updatedAt: 1 });

export type SettlementFields = InferSchemaType<typeof settlementSchema>;
export type SettlementDoc = HydratedDocument<SettlementFields>;
export const Settlements = model('Settlement', settlementSchema);
