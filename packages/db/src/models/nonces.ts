import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const nonceSchema = new Schema(
  {
    wallet: { type: String, required: true },
    nonce: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'nonces', autoIndex: false },
);

nonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
nonceSchema.index({ wallet: 1, nonce: 1 });

export type NonceFields = InferSchemaType<typeof nonceSchema>;
export type NonceDoc = HydratedDocument<NonceFields>;
export const Nonces = model('Nonce', nonceSchema);
