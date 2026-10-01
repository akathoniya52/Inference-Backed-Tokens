import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

export const DEPOSIT_STATUSES = ['credited', 'rejected'] as const;

const depositSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    txSignature: { type: String, required: true },
    amountMicroUsdc: { type: BigInt, required: true },
    slot: { type: Number, required: true },
    verifiedAt: { type: Date, required: true },
    status: { type: String, enum: DEPOSIT_STATUSES, required: true },
    reason: { type: String, default: null },
  },
  { collection: 'deposits', timestamps: true, autoIndex: false },
);

depositSchema.index({ txSignature: 1 }, { unique: true });

export type DepositFields = InferSchemaType<typeof depositSchema>;
export type DepositDoc = HydratedDocument<DepositFields>;
export const Deposits = model('Deposit', depositSchema);
