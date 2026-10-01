import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const SNAPSHOT_TTL_S = 30 * 24 * 60 * 60;

const poolSnapshotSchema = new Schema(
  {
    modelId: { type: Schema.Types.ObjectId, ref: 'Model', required: true },
    pool: { type: String, required: true },
    ts: { type: Date, required: true },
    quoteReserve: { type: String, required: true },
    baseReserve: { type: String, required: true },
    sqrtPrice: { type: String, required: true },
    progress: { type: Number, required: true },
    priceSolPerToken: { type: Number, required: true },
    totalTradingQuoteFee: { type: String, required: true, default: '0' },
    isMigrated: { type: Boolean, required: true, default: false },
  },
  { collection: 'poolSnapshots', autoIndex: false },
);

poolSnapshotSchema.index({ modelId: 1, ts: 1 });
poolSnapshotSchema.index({ ts: 1 }, { expireAfterSeconds: SNAPSHOT_TTL_S });

export type PoolSnapshotFields = InferSchemaType<typeof poolSnapshotSchema>;
export type PoolSnapshotDoc = HydratedDocument<PoolSnapshotFields>;
export const PoolSnapshots = model('PoolSnapshot', poolSnapshotSchema);
