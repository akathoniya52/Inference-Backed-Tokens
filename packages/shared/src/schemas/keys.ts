import { z } from 'zod';

import { API_KEY_PREFIX } from '../constants.js';
import {
  IsoDateTimeSchema,
  ObjectIdSchema,
  UsdcAmountSchema,
  UsdcInputSchema,
  paginated,
} from './common.js';

export const ApiKeyStatusSchema = z.enum(['active', 'revoked']);

export const CreateApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  dailyCapUsdc: UsdcInputSchema.optional(),
});

export const ApiKeySchema = z.object({
  id: ObjectIdSchema,
  name: z.string(),
  prefix: z.string(),
  status: ApiKeyStatusSchema,
  dailyCapUsdc: UsdcAmountSchema,
  lastUsedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});

/** The only response that ever carries the full key (L224). */
export const CreateApiKeyResponseSchema = ApiKeySchema.extend({
  key: z.string().startsWith(API_KEY_PREFIX),
});

export const ListApiKeysResponseSchema = paginated(ApiKeySchema);
export const RevokeApiKeyResponseSchema = ApiKeySchema;

export type ApiKeyStatus = z.infer<typeof ApiKeyStatusSchema>;
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>;
export type ApiKey = z.infer<typeof ApiKeySchema>;
export type CreateApiKeyResponse = z.infer<typeof CreateApiKeyResponseSchema>;
export type ListApiKeysResponse = z.infer<typeof ListApiKeysResponseSchema>;
export type RevokeApiKeyResponse = z.infer<typeof RevokeApiKeyResponseSchema>;
