import { HoldStatusSchema, LedgerTypeSchema } from '@ibt/shared';
import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const ledgerRefSchema = new Schema(
  {
    txSignature: { type: String },
    requestId: { type: String },
    holdId: { type: Schema.Types.ObjectId },
    settlementId: { type: Schema.Types.ObjectId },
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
  },
  { collection: 'ledger', timestamps: { createdAt: true, updatedAt: false }, autoIndex: false },
);

ledgerSchema.index({ userId: 1, createdAt: 1 });
ledgerSchema.index({ type: 1, status: 1, expiresAt: 1 });

export type LedgerFields = InferSchemaType<typeof ledgerSchema>;
export type LedgerDoc = HydratedDocument<LedgerFields>;
export const Ledger = model('LedgerEntry', ledgerSchema);
