import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * G21: one row per API key and UTC day. `reservedMicroUsdc` is the captured
 * spend plus every open hold of that day, moved inside the ledger transactions.
 */
const dailySpendSchema = new Schema(
  {
    apiKeyId: { type: Schema.Types.ObjectId, ref: 'ApiKey', required: true },
    day: { type: Date, required: true },
    reservedMicroUsdc: { type: BigInt, required: true, default: 0n },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'dailySpend', autoIndex: false },
);

dailySpendSchema.index({ apiKeyId: 1, day: 1 }, { unique: true });
dailySpendSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type DailySpendFields = InferSchemaType<typeof dailySpendSchema>;
export type DailySpendDoc = HydratedDocument<DailySpendFields>;
export const DailySpend = model('DailySpend', dailySpendSchema);
