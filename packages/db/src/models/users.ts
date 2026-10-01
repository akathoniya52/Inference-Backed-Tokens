import { UserRoleSchema } from '@ibt/shared';
import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    wallet: { type: String, required: true },
    role: { type: String, enum: UserRoleSchema.options, required: true, default: 'consumer' },
    depositRef: { type: String, required: true },
    balanceMicroUsdc: { type: BigInt, required: true, default: 0n },
    /** Sum of open holds (G14); `balance − held` is the spendable amount. */
    heldMicroUsdc: { type: BigInt, required: true, default: 0n },
    lastSeenAt: { type: Date, default: null },
  },
  { collection: 'users', timestamps: true, autoIndex: false },
);

userSchema.index({ wallet: 1 }, { unique: true });
userSchema.index({ depositRef: 1 }, { unique: true });

export type UserFields = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserFields>;
export const Users = model('User', userSchema);
