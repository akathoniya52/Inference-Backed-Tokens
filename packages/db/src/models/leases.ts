import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const leaseSchema = new Schema(
  {
    name: { type: String, required: true },
    owner: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'leases', autoIndex: false },
);

leaseSchema.index({ name: 1 }, { unique: true });
leaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type LeaseFields = InferSchemaType<typeof leaseSchema>;
export type LeaseDoc = HydratedDocument<LeaseFields>;
export const Leases = model('Lease', leaseSchema);
