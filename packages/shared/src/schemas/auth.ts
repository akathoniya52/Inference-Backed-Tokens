import { z } from 'zod';

import { IsoDateTimeSchema, ObjectIdSchema, PublicKeySchema, UsdcAmountSchema } from './common.js';

export const UserRoleSchema = z.enum(['consumer', 'provider', 'admin']);

/** Ed25519 detached signature over the sign-in message, base58 (64 bytes). */
export const MessageSignatureSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/, 'must be a base58 Ed25519 signature');

export const NonceRequestSchema = z.object({ wallet: PublicKeySchema });
export const NonceResponseSchema = z.object({ nonce: z.string().min(16), message: z.string() });

export const VerifyRequestSchema = z.object({
  wallet: PublicKeySchema,
  signature: MessageSignatureSchema,
});

export const UserSchema = z.object({
  id: ObjectIdSchema,
  wallet: PublicKeySchema,
  role: UserRoleSchema,
});

export const VerifyResponseSchema = z.object({ token: z.string().min(1), user: UserSchema });

export const JwtClaimsSchema = z.object({
  userId: ObjectIdSchema,
  wallet: PublicKeySchema,
  role: UserRoleSchema,
});

export const MeResponseSchema = UserSchema.extend({
  depositRef: z.string().min(1),
  balanceUsdc: UsdcAmountSchema,
  heldUsdc: UsdcAmountSchema,
  availableUsdc: UsdcAmountSchema,
  createdAt: IsoDateTimeSchema,
});

export type UserRole = z.infer<typeof UserRoleSchema>;
export type NonceRequest = z.infer<typeof NonceRequestSchema>;
export type NonceResponse = z.infer<typeof NonceResponseSchema>;
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
export type User = z.infer<typeof UserSchema>;
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;
export type JwtClaims = z.infer<typeof JwtClaimsSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
