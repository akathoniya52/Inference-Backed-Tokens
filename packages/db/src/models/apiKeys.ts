import { ApiKeyStatusSchema, DAILY_CAP_DEFAULT_MICRO } from '@ibt/shared';
import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const apiKeySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    keyHash: { type: String, required: true },
    prefix: { type: String, required: true },
    name: { type: String, required: true },
    status: { type: String, enum: ApiKeyStatusSchema.options, required: true, default: 'active' },
    dailyCapMicroUsdc: { type: BigInt, required: true, default: DAILY_CAP_DEFAULT_MICRO },
    lastUsedAt: { type: Date, default: null },
  },
  { collection: 'apiKeys', timestamps: true, autoIndex: false },
);

apiKeySchema.index({ keyHash: 1 }, { unique: true });
apiKeySchema.index({ userId: 1, createdAt: 1 });

export type ApiKeyFields = InferSchemaType<typeof apiKeySchema>;
export type ApiKeyDoc = HydratedDocument<ApiKeyFields>;
export const ApiKeys = model('ApiKey', apiKeySchema);
