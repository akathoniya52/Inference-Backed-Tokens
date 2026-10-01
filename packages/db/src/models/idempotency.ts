import { IDEMPOTENCY_TTL_MS } from '@ibt/shared';
import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const idempotencySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, required: true },
    requestHash: { type: String, required: true },
    /** Stored response; `null` while the first request is in flight. */
    response: { type: Schema.Types.Mixed, default: null },
  },
  {
    collection: 'idempotency',
    timestamps: { createdAt: true, updatedAt: false },
    autoIndex: false,
  },
);

idempotencySchema.index({ userId: 1, key: 1 }, { unique: true });
idempotencySchema.index({ createdAt: 1 }, { expireAfterSeconds: IDEMPOTENCY_TTL_MS / 1000 });

export type IdempotencyFields = InferSchemaType<typeof idempotencySchema>;
export type IdempotencyDoc = HydratedDocument<IdempotencyFields>;
export const Idempotency = model('Idempotency', idempotencySchema);
