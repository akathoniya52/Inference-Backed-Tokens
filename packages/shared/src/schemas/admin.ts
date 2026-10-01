import { z } from 'zod';

import {
  DecimalStringSchema,
  ObjectIdSchema,
  PublicKeySchema,
  UsdcAmountSchema,
} from './common.js';
import { ModelStatusSchema } from './models.js';
import { SettlementStateSchema } from './tokens.js';

export const SettlementRetryResponseSchema = z.object({
  id: ObjectIdSchema,
  state: SettlementStateSchema,
});

export const ModelPauseResponseSchema = z.object({
  id: ObjectIdSchema,
  status: ModelStatusSchema,
});

export const FloatResponseSchema = z.object({
  keeper: z.object({
    wallet: PublicKeySchema,
    sol: DecimalStringSchema,
    minSol: DecimalStringSchema,
    belowMin: z.boolean(),
  }),
  treasury: z.object({
    wallet: PublicKeySchema,
    usdc: UsdcAmountSchema,
    nextExpectedPayoutUsdc: UsdcAmountSchema,
    belowNextPayout: z.boolean(),
  }),
});

export const HealthChecksRunResponseSchema = z.object({
  checked: z.int().min(0),
  ok: z.int().min(0),
  failed: z.int().min(0),
  paused: z.int().min(0),
});

export type SettlementRetryResponse = z.infer<typeof SettlementRetryResponseSchema>;
export type ModelPauseResponse = z.infer<typeof ModelPauseResponseSchema>;
export type FloatResponse = z.infer<typeof FloatResponseSchema>;
export type HealthChecksRunResponse = z.infer<typeof HealthChecksRunResponseSchema>;
